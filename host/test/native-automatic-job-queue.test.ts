import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { ConfiguredMoonraker } from '../src/moonraker/configured-server.ts';
import { DatabaseStore } from '../src/moonraker/database.ts';
import { PrintJournal } from '../src/operations/print-journal.ts';
import { PrintController } from '../src/operations/print.ts';
import { MaintenanceGate } from '../src/operations/maintenance-gate.ts';
import { NativePrintUploads } from '../src/moonraker/native-print-uploads.ts';
import { PublishedPrintFiles } from '../src/storage/published-files.ts';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { externalAcceptanceBundle, assertSeparateAcceptanceWorkspace, assertAcceptanceBundleUnchanged } from './helpers/acceptance-bundle.ts';

const retained = await externalAcceptanceBundle();
if (retained) after(() => assertAcceptanceBundleUnchanged(retained));

async function fixture() {
  // A pinned run uses actual emitted production owners and JS worker entries;
  // the TypeScript test is only the driver, never a product startup profile.
  const [serverModule, databaseModule, journalModule, controllerModule, gateModule, uploadsModule, filesModule] = retained ? await Promise.all([
    import(pathToFileURL(join(retained.path, 'host/src/moonraker/configured-server.js')).href) as Promise<typeof import('../src/moonraker/configured-server.ts')>,
    import(pathToFileURL(join(retained.path, 'host/src/moonraker/database.js')).href) as Promise<typeof import('../src/moonraker/database.ts')>,
    import(pathToFileURL(join(retained.path, 'host/src/operations/print-journal.js')).href) as Promise<typeof import('../src/operations/print-journal.ts')>,
    import(pathToFileURL(join(retained.path, 'host/src/operations/print.js')).href) as Promise<typeof import('../src/operations/print.ts')>,
    import(pathToFileURL(join(retained.path, 'host/src/operations/maintenance-gate.js')).href) as Promise<typeof import('../src/operations/maintenance-gate.ts')>,
    import(pathToFileURL(join(retained.path, 'host/src/moonraker/native-print-uploads.js')).href) as Promise<typeof import('../src/moonraker/native-print-uploads.ts')>,
    import(pathToFileURL(join(retained.path, 'host/src/storage/published-files.js')).href) as Promise<typeof import('../src/storage/published-files.ts')>,
  ]) : [{ ConfiguredMoonraker }, { DatabaseStore }, { PrintJournal }, { PrintController }, { MaintenanceGate }, { NativePrintUploads }, { PublishedPrintFiles }];
  const { ConfiguredMoonraker: Server } = serverModule, { DatabaseStore: Database } = databaseModule, { PrintJournal: Journal } = journalModule,
    { PrintController: Controller } = controllerModule, { MaintenanceGate: Gate } = gateModule, { NativePrintUploads: Uploads } = uploadsModule, { PublishedPrintFiles: Files } = filesModule;
  const root = await mkdtemp(join(tmpdir(), 'automatic-native-queue-')), config = join(root, 'moonraker.conf');
  if (retained) await assertSeparateAcceptanceWorkspace(retained, root);
  await writeFile(config, '[server]\nhost=127.0.0.1\nport=0\n[job_queue]\nautomatic_transition=true\njob_transition_delay=0.15\n');
  const database = await Database.open({ path: join(root, 'moonraker.db') });
  const journal = await Journal.open({ path: join(root, 'prints.db'), deviceId: 'queue-printer' });
  const files = await Files.open(join(root, 'files')), gate = new Gate();
  const processFiles = await Uploads.open(files, gate, { stagingRoot: root, metadataRoot: join(root, 'metadata') });
  const deviceFiles = new Uploads(files, gate, { stagingRoot: root }, processFiles), starts: string[] = [];
  const controller = new Controller({ async prepare() {}, async start(id) { starts.push(id); }, async pause() {}, async resume() {}, async finish() {}, async stop() {} }, { maxNozzle: 300, maxBed: 120 }, {}, { journal, maintenanceGate: gate });
  let key: string;
  await writeFile(join(root, 'source.gcode'), 'G1 X1 F600\n'); const source = await open(join(root, 'source.gcode'), 'r');
  try { await files.publish('one', 'one.gcode', source, new AbortController().signal); } finally { await source.close(); }
  const server = await Server.loadAuthorized(config, {
    information: { connected: false, state: 'disconnected', components: [], failedComponents: [], directories: [], warnings: [], version: 'queue-test', missingRequirements: [] },
    database, authorization: { issuer: 'https://queue.invalid' }, productPrint: controller, maintenanceGate: gate,
    nativeUploads: deviceFiles, nativeProcessFiles: processFiles, nativeProcessHistory: journal,
    productPrintCompatibility: { async start(filename, signal) { return { fileId: await processFiles.resolveQueuedFile(filename, signal), nozzle: 0, bed: 0 }; } },
    nativeHost: () => ({ group_state: 'ready', hardware_state: 'ready', print_state: controller.state, homed_axes: '', closing: false, admission_closed: gate.status.closed, maintenance: false, mcus: [{ id: 'simulated-status', state: 'ready' }] }),
    nativePrinterIdentity: { configFile: join(root, 'printer.cfg'), softwareVersion: 'queue-test' },
  });
  const { port } = await server.start(), base = `http://127.0.0.1:${port}`; key = server.authorization!.localApiKey();
  const call = async (path: string, method = 'GET', body?: object, token?: string) => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...token ? { authorization: 'Bearer ' + token } : { 'x-api-key': key } }, ...body ? { body: JSON.stringify(body) } : {} });
    const value = await response.json() as any; assert.equal(response.status, 200, JSON.stringify(value)); return value.result;
  };
  const status = () => call('/server/job_queue/status');
  const until = async (predicate: () => boolean | Promise<boolean>) => {
    const deadline = performance.now() + 5000;
    while (!await predicate()) { assert(performance.now() < deadline, 'Automatic queue did not reach the required state'); await delay(5); }
  };
  return { root, base, server, journal, controller, starts, call, status, until,
    async rotate() { key = await call('/access/api_key', 'POST'); },
    async close() { await server.close(); await deviceFiles.drain(); await processFiles.drain(); await files.close(); await journal.close(); await database.close(); await rm(root, { recursive: true, force: true }); },
  };
}

test('authorized HTTP automatic queue consumes matching durable completion once using the shared controller and history', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.status()).queue_state, 'paused');
    await f.call('/server/job_queue/job', 'POST', { filenames: ['one.gcode', 'one.gcode', 'one.gcode'] });
    assert.equal(f.starts.length, 0);
    const started = await f.call('/server/job_queue/start', 'POST'); assert.equal(started.queue_state, 'ready');
    const first = f.controller.currentRequest!;
    await delay(180); assert.equal(f.starts.length, 1);
    await f.controller.complete(first.requestId);
    await f.until(async () => f.starts.length === 2 && f.controller.state === 'printing' && (await f.status()).queued_jobs.length === 1);
    const second = f.controller.currentRequest!; assert.notEqual(second.requestId, first.requestId);
    assert.equal((await f.status()).queued_jobs.length, 1);
    await f.controller.complete(second.requestId); await f.until(async () => f.starts.length === 3 && f.controller.state === 'printing' && (await f.status()).queued_jobs.length === 0);
    const third = f.controller.currentRequest!; await f.controller.complete(third.requestId);
    await f.until(async () => (await f.status()).queue_state === 'paused');
    await delay(180); assert.equal(f.starts.length, 3);
    const rows = await f.journal.historyList({ limit: 10 });
    assert.equal(rows.filter(row => row.request.requestId.startsWith('queue-') && row.state === 'completed').length, 3);
    assert.equal((await f.status()).queued_jobs.length, 0);
  } finally { await f.close(); }
});

for (const boundary of ['pause', 'pause-delay', 'cancel', 'failed', 'key-rotation', 'logout', 'expiry', 'generation', 'close'] as const) test('automatic continuation is revoked by ' + boundary + ' without admitting another print', async t => {
  if (boundary === 'expiry') t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = await fixture();
  let closed = false;
  try {
    let token: string | undefined;
    if (boundary === 'logout' || boundary === 'expiry') token = (await f.call('/access/user', 'POST', { username: 'operator', password: 'pass' })).token;
    await f.call('/server/job_queue/job', 'POST', { filenames: ['one.gcode', 'one.gcode'] }, token);
    await f.call('/server/job_queue/start', 'POST', undefined, token);
    await f.until(() => f.controller.state === 'printing');
    assert.equal(f.starts.length, 1); const first = f.controller.currentRequest!;
    if (boundary === 'pause') { await f.call('/server/job_queue/pause', 'POST'); assert.equal(f.controller.state, 'printing'); }
    if (boundary === 'key-rotation') await f.rotate();
    if (boundary === 'logout') await f.call('/access/logout', 'POST', undefined, token);
    if (boundary === 'expiry') t.mock.timers.tick(3601000);
    if (boundary === 'generation') await f.server.retireNativePrinter();
    else if (boundary === 'failed') await f.controller.fault(new Error('Fixture device fault'));
    else if (boundary === 'cancel') await f.controller.cancel();
    else await f.controller.complete(first.requestId);
    if (boundary === 'pause-delay') await f.call('/server/job_queue/pause', 'POST');
    if (boundary === 'close') { await f.close(); closed = true; }
    await delay(220); assert.equal(f.starts.length, 1);
    if (!closed) { assert.equal((await f.status()).queued_jobs.length, 1); assert.equal((await f.status()).queue_state, 'paused'); }
  } finally { if (!closed) await f.close(); }
});

test('adding during an active native print arms automatic queue but an explicit pause prevents rearming', async () => {
  const f = await fixture();
  try {
    await f.call('/printer/print/start', 'POST', { filename: 'one.gcode' });
    await f.call('/server/job_queue/job', 'POST', { filenames: ['one.gcode'] });
    assert.equal((await f.status()).queue_state, 'ready', JSON.stringify({ state: f.controller.state, request: f.controller.currentRequest, starts: f.starts }));
    await f.until(() => f.controller.state === 'printing');
    await f.controller.complete(f.controller.currentRequest!.requestId); await f.until(async () => f.starts.length === 2 && f.controller.state === 'printing' && (await f.status()).queued_jobs.length === 0);
    await f.call('/server/job_queue/pause', 'POST');
    await f.call('/server/job_queue/job', 'POST', { filenames: ['one.gcode'] });
    await f.controller.complete(f.controller.currentRequest!.requestId); await delay(220);
    assert.equal(f.starts.length, 2); assert.equal((await f.status()).queue_state, 'paused');
    await f.call('/server/job_queue/start', 'POST'); assert.equal(f.starts.length, 3);
  } finally { await f.close(); }
});

test('a different login on the initiating WebSocket cannot replace the captured continuation principal', async () => {
  const f = await fixture(); let socket: WebSocket | undefined;
  try {
    const alice = await f.call('/access/user', 'POST', { username: 'alice', password: 'pass' });
    await f.call('/access/user', 'POST', { username: 'bob', password: 'pass' });
    socket = new WebSocket(f.base.replace('http:', 'ws:') + '/websocket'); await once(socket, 'open');
    let id = 0;
    const rpc = (method: string, params = {}) => new Promise<any>((resolve, reject) => {
      const requestId = ++id;
      const listener = (raw: Buffer) => { const result = JSON.parse(raw.toString()); if (result.id !== requestId) return; socket!.off('message', listener); if (result.error) reject(new Error(JSON.stringify(result.error))); else resolve(result.result); };
      socket!.on('message', listener); socket!.send(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }));
    });
    await rpc('access.login', { username: 'alice', password: 'pass' });
    await rpc('server.job_queue.post_job', { filenames: ['one.gcode', 'one.gcode'] });
    await rpc('server.job_queue.start'); await f.until(() => f.controller.state === 'printing');
    await rpc('access.login', { username: 'bob', password: 'pass' });
    await f.call('/access/logout', 'POST', undefined, alice.token);
    assert.equal((await rpc('access.get_user')).username, 'bob');
    await f.controller.complete(f.controller.currentRequest!.requestId); await delay(220);
    assert.equal(f.starts.length, 1); assert.equal((await f.status()).queue_state, 'paused');
    assert.equal((await f.status()).queued_jobs.length, 1);
  } finally { socket?.terminate(); await f.close(); }
});
