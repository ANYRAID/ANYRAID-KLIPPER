import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeJobQueue, registerNativeJobQueue, type NativeJobQueueOptions } from '../src/moonraker/native-job-queue.ts';
import { DatabaseStore, type DatabaseStoreOptions } from '../src/moonraker/database.ts';
import { PrintJournal } from '../src/operations/print-journal.ts';
import { PrintController } from '../src/operations/print.ts';
import { ApiError, JsonRpcDispatcher, type RpcContext, type Json } from '../src/moonraker/rpc.ts';
import { EndpointRegistry } from '../src/moonraker/endpoints.ts';
import { MoonrakerNetwork } from '../src/moonraker/server.ts';
import { setTimeout as delay } from 'node:timers/promises';

const context = (authorize: RpcContext['authorize'] = () => ({ username: 'operator' })): RpcContext => ({ transport: 'http', signal: new AbortController().signal, user: { username: 'operator' }, authorize });
async function fixture(overrides: Partial<NativeJobQueueOptions> = {}, databaseOptions: Partial<DatabaseStoreOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'native-job-queue-'));
  const database = await DatabaseStore.open({ ...databaseOptions, path: join(root, 'moonraker.db') });
  const journal = await PrintJournal.open({ path: join(root, 'jobs.db'), deviceId: 'queue-printer' });
  const calls: string[] = [], files = new Map([['one.gcode', 'file-one'], ['two.gcode', 'file-two']]);
  const controller = new PrintController({ async prepare(request) { calls.push('prepare:' + request.requestId); }, async start(id) { calls.push('start:' + id); }, async pause() {}, async resume() {}, async finish() {}, async stop() {} }, { maxNozzle: 300, maxBed: 120 }, {}, { journal });
  const events: Json[] = [];
  const options: NativeJobQueueOptions = {
    database, journal,
    async resolveFile(filename, signal) { signal.throwIfAborted(); const id = files.get(filename); if (!id) throw new ApiError(404, 'Missing published file'); return id; },
    canStart: () => ['idle', 'completed', 'cancelled'].includes(controller.state),
    async start(job, requestId, ctx) {
      ctx.signal.throwIfAborted(); if (controller.currentRequest) controller.reset(controller.currentRequest.requestId);
      await controller.admit({ version: 1, requestId, fileId: job.file_id, nozzle: 0, bed: 0, expiresAt: Date.now() + 30000 });
    },
    notify: event => { events.push(event); }, ...overrides,
  };
  let queue = await NativeJobQueue.open(options);
  return { root, database, journal, controller, files, calls, events, options, get queue() { return queue; }, async reopen() { await queue.close(); queue = await NativeJobQueue.open(options); return queue; }, async close() { await queue.close(); await controller.cancel(); await journal.close(); await database.close(); await rm(root, { recursive: true, force: true }); } };
}
const statusError = (status: number) => (error: unknown) => error instanceof ApiError && error.status === status;
const automatic = {
  automaticTransition: true, transitionDelayMs: 10,
  captureAuthority: (ctx: RpcContext, lifetime: AbortSignal) => ({ ...ctx, signal: AbortSignal.any([lifetime, ctx.nativeGenerationSignal!]) }),
};
const automaticContext = (): RpcContext => ({ ...context(), nativeGenerationSignal: new AbortController().signal });

test('automatic owner restart retains remaining jobs but discards every execution grant', async () => {
  const f = await fixture({ ...automatic, activePrint: () => undefined });
  try {
    const ctx = automaticContext();
    await f.queue.add(['one.gcode', 'two.gcode'], false, ctx); await f.queue.start(ctx);
    while (f.controller.state === 'preparing') await delay(1);
    assert.equal(f.queue.diagnostics.automatic.armed, true);
    await f.reopen(); assert.equal(f.queue.diagnostics.automatic.armed, false);
    await f.controller.complete(f.controller.currentRequest!.requestId); await delay(30);
    assert.equal(f.calls.filter(c => c.startsWith('start:')).length, 1);
    assert.equal(f.queue.status.queue_state, 'paused'); assert.equal(f.queue.status.queued_jobs.length, 1);
    assert.equal(JSON.stringify(await f.database.get('native_job_queue', 'catalogue')).includes('token'), false);
  } finally { await f.close(); }
});

test('completion during the first admission is retained and duplicate or unrelated events cannot dispatch extra jobs', async () => {
  const f = await fixture(); await f.queue.close();
  let observe: Parameters<PrintJournal['subscribeHistory']>[0] | undefined;
  let finished: Parameters<NonNullable<typeof observe>>[0] | undefined;
  const subscribe = f.journal.subscribeHistory.bind(f.journal);
  f.journal.subscribeHistory = listener => { observe = listener; return subscribe(event => {
    if (event.action === 'finished') {
      finished = event;
      listener({ ...event, record: { ...event.record, request: { ...event.record.request, requestId: 'unrelated' } } });
    }
    listener(event); listener(event);
  }); };
  const queue = await NativeJobQueue.open({ ...f.options, ...automatic, activePrint: () => undefined,
    async start(job, id, ctx) {
      await f.options.start(job, id, ctx); while (f.controller.state === 'preparing') await delay(1);
      await f.controller.complete(id);
    },
  });
  try {
    await queue.add(['one.gcode', 'two.gcode'], false, automaticContext()); await queue.start(automaticContext());
    const deadline = performance.now() + 3000;
    while (queue.status.queued_jobs.length || queue.diagnostics.dispatching) { assert(performance.now() < deadline); await delay(2); }
    assert.equal(f.calls.filter(c => c.startsWith('start:')).length, 2);
    assert(finished); observe!(finished); observe!({ ...finished, record: { ...finished.record, request: { ...finished.record.request, requestId: 'unrelated' } } });
    await delay(30); assert.equal(f.calls.filter(c => c.startsWith('start:')).length, 2);
    assert.equal(queue.status.queue_state, 'paused'); assert.equal(queue.diagnostics.claim, null);
  } finally { await queue.close(); await f.close(); }
});

test('a durable reservation followed by an uncertain failure pauses automatic mode without retry or replay', async () => {
  const f = await fixture(); await f.queue.close(); let attempts = 0;
  const options = { ...f.options, ...automatic, activePrint: () => undefined,
    async start(job: import('../src/moonraker/native-job-queue.ts').QueuedNativeJob, id: string) {
      attempts++; await f.journal.reserve({ version: 1, requestId: id, fileId: job.file_id, nozzle: 0, bed: 0 });
      throw new Error('Fixture response lost after durable reservation');
    },
  };
  const queue = await NativeJobQueue.open(options);
  try {
    await queue.add(['one.gcode', 'two.gcode'], false, automaticContext());
    await assert.rejects(queue.start(automaticContext()), /response lost/); await delay(30);
    assert.equal(attempts, 1); assert.equal(queue.status.queued_jobs.length, 1); assert.equal(queue.status.queue_state, 'paused');
    assert.equal(queue.diagnostics.automatic.armed, false); await queue.close();
    const reopened = await NativeJobQueue.open(options);
    try { await delay(30); assert.equal(attempts, 1); assert.equal(reopened.status.queue_state, 'paused'); }
    finally { await reopened.close(); }
  } finally { await queue.close(); await f.close(); }
});

test('queue admission is all-or-nothing, idempotent, private, and durable across owner restart', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.queue.add(['one.gcode', 'missing.gcode'], false, context()), statusError(404));
    assert.equal(f.queue.status.queued_jobs.length, 0); assert.equal(f.queue.diagnostics.revision, 0);
    await f.queue.add(['one.gcode', 'two.gcode'], false, context(), 'enqueue-1');
    const first = f.queue.status; assert.equal(first.queue_state, 'paused'); assert.equal(first.queued_jobs.length, 2);
    await f.queue.add(['one.gcode', 'two.gcode'], false, context(), 'enqueue-1'); assert.equal(f.queue.diagnostics.revision, 1);
    await assert.rejects(f.queue.add(['one.gcode'], false, context(), 'enqueue-1'), statusError(409));
    await assert.rejects(NativeJobQueue.open(f.options), /already owned/);
    await assert.rejects(f.database.api('GET', 'native_job_queue', undefined), statusError(403));
    const listing = await f.database.list() as { namespaces: string[] }; assert(!listing.namespaces.includes('native_job_queue'));
    await f.reopen(); assert.deepEqual(f.queue.status.queued_jobs.map(j => j.job_id), first.queued_jobs.map(j => j.job_id));
    await f.queue.add(['one.gcode', 'two.gcode'], false, context(), 'enqueue-1'); assert.equal(f.queue.diagnostics.revision, 1);
    await f.queue.jump(first.queued_jobs[1].job_id, context()); assert.equal(f.queue.status.queued_jobs[0].filename, 'two.gcode');
    await f.queue.remove([first.queued_jobs[1].job_id], false, context()); assert.equal(f.queue.status.queued_jobs.length, 1);
    await f.queue.remove([], true, context()); assert.equal(f.queue.status.queued_jobs.length, 0);
    await f.reopen(); assert.equal(f.queue.status.queued_jobs.length, 0); assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('queue dispatch uses one stable request in the actual print journal and does not cancel active printing', async () => {
  const f = await fixture();
  try {
    await f.queue.add(['one.gcode', 'two.gcode'], false, context());
    await f.queue.start(context());
    assert.equal(f.controller.state, 'printing'); assert.equal(f.queue.status.queued_jobs.length, 1);
    const request = f.controller.currentRequest!; assert.match(request.requestId, /^queue-/);
    assert.equal((await f.journal.get(request.requestId))!.request.fileId, 'file-one');
    assert.equal(f.calls.filter(c => c.startsWith('start:')).length, 1);
    await f.queue.pause(); assert.equal(f.controller.state, 'printing');
    await f.queue.start(context()); assert.equal(f.calls.filter(c => c.startsWith('start:')).length, 1);
    await f.controller.complete(request.requestId);
    await f.queue.start(context()); assert.equal(f.queue.status.queued_jobs.length, 0);
    assert.equal(f.calls.filter(c => c.startsWith('start:')).length, 2);
    const rows = await f.journal.historyList({ limit: 10 }); assert.equal(rows.length, 2);
    assert.equal(f.queue.diagnostics.claim, null);
  } finally { await f.close(); }
});

test('replaced or denied queued files never reach device admission and remain observable', async () => {
  const f = await fixture();
  try {
    await f.queue.add(['one.gcode'], false, context());
    f.files.set('one.gcode', 'replacement');
    await assert.rejects(f.queue.start(context()), statusError(409));
    assert.equal(f.queue.status.queue_state, 'paused'); assert.equal(f.queue.status.queued_jobs.length, 1); assert.equal(f.calls.length, 0);
    f.files.set('one.gcode', 'file-one');
    await assert.rejects(f.queue.start(context(() => { throw new ApiError(403, 'Print denied'); })), statusError(403));
    assert.equal(f.queue.status.queued_jobs.length, 1); assert.equal(f.calls.length, 0);
    await assert.rejects(f.queue.add(['one.gcode', 'two.gcode'], true, context((_method, params) => { if (params.file_id === 'file-two') throw new ApiError(403, 'Second file denied'); })), statusError(403));
    assert.equal(f.queue.status.queued_jobs.length, 1); assert.equal(f.queue.diagnostics.revision, 1);
  } finally { await f.close(); }
});

test('pause during delayed authorization keeps reads live and forbids the subsequent print', async () => {
  const f = await fixture(), held = Promise.withResolvers<void>(), reached = Promise.withResolvers<void>();
  try {
    await f.queue.add(['one.gcode'], false, context());
    const pending = f.queue.start(context(async () => { reached.resolve(); await held.promise; }));
    await reached.promise; assert.equal(f.queue.status.queue_state, 'loading');
    const pause = f.queue.pause(); assert.equal(f.queue.status.queue_state, 'paused');
    for (let i = 0; i < 1000; i++) assert.equal(f.queue.status.queued_jobs.length, 1);
    held.resolve(); await pending; await pause; assert.equal(f.calls.length, 0); assert.equal(f.queue.diagnostics.claim, null);
    await f.queue.start(context()); assert.equal(f.calls.filter(c => c.startsWith('start:')).length, 1);
  } finally { held.resolve(); await f.close(); }
});

test('retired generation and closure during delayed authorization cannot bind a new printer', async () => {
  const f = await fixture(), held = Promise.withResolvers<void>(), reached = Promise.withResolvers<void>(), generation = new AbortController();
  try {
    await f.queue.add(['one.gcode'], false, context());
    await assert.rejects(f.queue.start({ ...context(), nativeGenerationRetiredAtAdmission: true }), statusError(503));
    const pending = f.queue.start({ ...context(async () => { reached.resolve(); await held.promise; }), nativeGenerationSignal: generation.signal });
    const observed = assert.rejects(pending);
    await reached.promise; generation.abort(); held.resolve(); await observed;
    assert.equal(f.calls.length, 0); assert.equal(f.queue.status.queued_jobs.length, 1);
    await f.reopen(); assert.equal(f.queue.status.queue_state, 'paused');
  } finally { held.resolve(); await f.close(); }
});

test('recovery resolves claims from the real journal without device actions or automatic replay', async () => {
  for (const accepted of [false, true]) {
    const f = await fixture();
    try {
      await f.queue.add(['one.gcode', 'two.gcode'], false, context()); await f.queue.close();
      const value = await f.database.get('native_job_queue', 'catalogue') as any;
      value.claim = { job_id: value.jobs[0].job_id, request_id: 'queue-crash-claim', file_id: 'file-one' };
      await f.database.insert('native_job_queue', 'catalogue', value);
      if (accepted) await f.journal.reserve({ version: 1, requestId: 'queue-crash-claim', fileId: 'file-one', nozzle: 0, bed: 0 });
      await f.reopen(); assert.equal(f.queue.status.queued_jobs.length, accepted ? 1 : 2);
      assert.equal(f.queue.status.queue_state, 'paused'); assert.equal(f.queue.diagnostics.claim, null); assert.equal(f.calls.length, 0);
      if (accepted) assert.equal((await f.journal.get('queue-crash-claim'))!.state, 'reserved');
    } finally { await f.close(); }
  }
});

test('corrupt catalogues and mismatched journal claims fail closed without erasing members', async () => {
  for (const corruption of ['version', 'claim', 'identity', 'receipt-type']) {
    const f = await fixture();
    try {
      await f.queue.add(['one.gcode'], false, context()); await f.queue.close();
      const value = await f.database.get('native_job_queue', 'catalogue') as any;
      if (corruption === 'version') value.version = 2;
      if (corruption === 'claim') value.claim = { job_id: '0000000000000000', request_id: 'foreign', file_id: 'file-one' };
      if (corruption === 'receipt-type') value.receipts = [{ id: 'corrupt-receipt', fingerprint: ['a'.repeat(64)], jobs: [] }];
      if (corruption === 'identity') {
        value.claim = { job_id: value.jobs[0].job_id, request_id: 'wrong-file', file_id: 'file-one' };
        await f.journal.reserve({ version: 1, requestId: 'wrong-file', fileId: 'another-file', nozzle: 0, bed: 0 });
      }
      await f.database.insert('native_job_queue', 'catalogue', value);
      await assert.rejects(NativeJobQueue.open(f.options), statusError(503));
      assert.deepEqual(await f.database.get('native_job_queue', 'catalogue'), value);
      assert.equal(f.calls.length, 0);
    } finally { await f.close(); }
  }
});

test('new database and journal workers recover an interrupted accepted claim without replay', async () => {
  const f = await fixture();
  let database: DatabaseStore | undefined, journal: PrintJournal | undefined, queue: NativeJobQueue | undefined;
  try {
    await f.queue.add(['one.gcode', 'two.gcode'], false, context()); await f.queue.close();
    const saved = await f.database.get('native_job_queue', 'catalogue') as any;
    saved.claim = { job_id: saved.jobs[0].job_id, request_id: 'queue-worker-restart', file_id: 'file-one' };
    await f.database.insert('native_job_queue', 'catalogue', saved);
    await f.journal.reserve({ version: 1, requestId: 'queue-worker-restart', fileId: 'file-one', nozzle: 0, bed: 0 });
    await f.journal.close(); await f.database.close();
    database = await DatabaseStore.open({ path: join(f.root, 'moonraker.db') });
    journal = await PrintJournal.open({ path: join(f.root, 'jobs.db'), deviceId: 'queue-printer' });
    let starts = 0;
    queue = await NativeJobQueue.open({ ...f.options, database, journal, async start() { starts++; throw new Error('Recovery must not start'); } });
    assert.equal((await journal.get('queue-worker-restart'))!.state, 'interrupted');
    assert.equal(queue.status.queued_jobs.length, 1); assert.equal(queue.status.queued_jobs[0].filename, 'two.gcode');
    assert.equal(queue.status.queue_state, 'paused'); assert.equal(queue.diagnostics.claim, null); assert.equal(starts, 0);
    await assert.rejects(database.api('GET', 'native_job_queue', 'catalogue'), statusError(403));
  } finally { await queue?.close(); await journal?.close(); await database?.close(); await f.close(); }
});

test('failed catalogue write latches mutations while existing read snapshot survives', async () => {
  const f = await fixture();
  try {
    await f.queue.add(['one.gcode'], false, context()); await f.database.close();
    await assert.rejects(f.queue.remove([], true, context()), statusError(503));
    assert.equal(f.queue.status.queued_jobs.length, 1); assert.equal(f.queue.diagnostics.storage_failed, true);
    await assert.rejects(f.queue.start(context()), statusError(503)); assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('known record-capacity rejection rolls back the complete batch without poisoning subsequent admissions', async () => {
  const f = await fixture({}, { maxRecordBytes: 300 });
  try {
    // Four members exceed 300 bytes even when timestamps serialize as integers.
    await assert.rejects(f.queue.add(['one.gcode', 'two.gcode', 'one.gcode', 'two.gcode'], false, context()), statusError(413));
    assert.equal(f.queue.status.queued_jobs.length, 0); assert.equal(f.queue.diagnostics.revision, 0); assert.equal(f.queue.diagnostics.storage_failed, false);
    await f.queue.add(['one.gcode'], false, context()); assert.equal(f.queue.status.queued_jobs.length, 1); assert.equal(f.queue.diagnostics.revision, 1);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('an uncertain accepted admission is consumed from journal once and never silently retried', async () => {
  const f = await fixture();
  try {
    await f.queue.add(['one.gcode'], false, context()); await f.queue.close();
    let attempts = 0;
    const queue = await NativeJobQueue.open({ ...f.options, async start(job, requestId) {
      attempts++; await f.journal.reserve({ version: 1, requestId, fileId: job.file_id, nozzle: 0, bed: 0 });
      throw new Error('Response after reservation was lost');
    } });
    try {
      await assert.rejects(queue.start(context()), /Response after reservation was lost/);
      assert.equal(queue.status.queued_jobs.length, 0); assert.equal(queue.diagnostics.claim, null);
      await queue.start(context()); assert.equal(attempts, 1);
      const rows = await f.journal.historyList({ limit: 10 }); assert.equal(rows.length, 1); assert.equal(rows[0].state, 'reserved');
      assert.equal(f.calls.length, 0);
    } finally { await queue.close(); }
  } finally { await f.close(); }
});

test('catalogue restart does not expose private entries or share ownership and notification failure cannot undo a commit', async () => {
  const f = await fixture({ notify() { throw new Error('Observer failed'); } });
  try {
    await f.queue.add(['one.gcode'], false, context()); await f.queue.pause();
    await f.queue.close(); assert.equal(f.queue.status.queued_jobs.length, 1);
    assert.match(f.queue.diagnostics.notifications.error!, /Observer failed/);
    await assert.rejects(f.database.api('POST', 'native_job_queue', 'catalogue', {}), statusError(403));
    await assert.rejects(f.database.api('DELETE', 'native_job_queue', 'catalogue'), statusError(403));
    await f.reopen(); assert.equal(f.queue.status.queued_jobs.length, 1);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('REST and JSON-RPC expose the same authenticated queue with upstream shapes and strict arguments', async () => {
  const f = await fixture(), rpc = new JsonRpcDispatcher(), registry = new EndpointRegistry(rpc), release = registerNativeJobQueue(registry, f.queue);
  const network = new MoonrakerNetwork(rpc, { endpoints: registry, authorize(_method, _params, ctx) { if (ctx.request.headers['x-api-key'] !== 'queue-test') throw new ApiError(401, 'Denied'); return { username: 'operator' }; } });
  try {
    const { port } = await network.listen(), base = `http://127.0.0.1:${port}`, headers = { 'x-api-key': 'queue-test', 'content-type': 'application/json' };
    assert.equal((await fetch(base + '/server/job_queue/status')).status, 401);
    const response = await fetch(base + '/server/job_queue/job', { method: 'POST', headers, body: JSON.stringify({ filenames: ['one.gcode', 'two.gcode'], reset: 'FALSE', request_id: 'rest-add' }) });
    assert.equal(response.status, 200); const result = (await response.json()).result;
    assert.equal(result.queued_jobs.length, 2); assert.match(result.queued_jobs[0].job_id, /^[A-F0-9]{16}$/);
    assert.deepEqual(Object.keys(result.queued_jobs[0]).sort(), ['filename', 'job_id', 'time_added', 'time_in_queue']);
    const responseRpc = await fetch(base + '/server/jsonrpc', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server.job_queue.jump', params: { job_id: result.queued_jobs[1].job_id } }) });
    assert.equal((await responseRpc.json()).result.queued_jobs[0].filename, 'two.gcode');
    const removed = await fetch(base + '/server/job_queue/job?all=TRUE', { method: 'DELETE', headers }); assert.equal(removed.status, 200); assert.equal((await removed.json()).result.queued_jobs.length, 0);
    for (const body of [{ filenames: ['one.gcode'], user: 'admin' }, { filenames: ['one.gcode'], reset: 1 }, { filenames: ['one.gcode'], request_id: 1 }]) {
      const invalid = await fetch(base + '/server/job_queue/job', { method: 'POST', headers, body: JSON.stringify(body) }); assert.equal(invalid.status, 400); await invalid.arrayBuffer();
    }
    assert.equal(f.calls.length, 0);
  } finally { release(); await network.close(); await f.close(); }
});
