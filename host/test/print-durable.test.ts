import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PrintJournal } from '../src/operations/print-journal.ts';
import { PrintController, type PrintDevice } from '../src/operations/print.ts';

const request = {
  version: 1 as const,
  requestId: 'job',
  fileId: 'file',
  nozzle: 200,
  bed: 60,
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'durable-controller-'));
  let journal = await PrintJournal.open({
    path: join(directory, 'jobs.db'),
    deviceId: 'printer',
  });
  t.after(async () => {
    await journal.close();
    await rm(directory, { recursive: true });
  });
  const calls: string[] = [];
  const device: PrintDevice = {
    prepare: async () => {
      assert.equal((await journal.get(request.requestId))?.state, 'reserved');
      calls.push('prepare');
    },
    start: async () => {
      calls.push('start');
    },
    pause: async () => {},
    resume: async () => {},
    finish: async () => {
      calls.push('finish');
    },
    stop: async () => {
      calls.push('stop');
    },
  };
  const controller = () =>
    new PrintController(
      device,
      { maxNozzle: 280, maxBed: 110 },
      {},
      { journal },
    );
  return {
    get journal() {
      return journal;
    },
    controller,
    device,
    calls,
    reopen: async () => {
      await journal.close();
      journal = await PrintJournal.open({
        path: join(directory, 'jobs.db'),
        deviceId: 'printer',
      });
    },
  };
}
test('durable lifecycle reserves before effects and refuses completed replay after restart', async (t) => {
  const f = await setup(t),
    c = f.controller();
  await c.start(request);
  assert.equal((await f.journal.get('job'))?.state, 'started');
  await c.complete('job');
  assert.equal((await f.journal.get('job'))?.state, 'completed');
  c.reset('job');
  await f.reopen();
  const next = f.controller();
  await assert.rejects(next.start(request), /reconciliation/);
  assert.equal(f.calls.filter((x) => x === 'start').length, 1);
  assert.equal((await f.journal.get('job'))?.state, 'completed');
});
test('cancel does not persist terminal state before device stop acknowledgement', async (t) => {
  const f = await setup(t),
    c = f.controller(),
    stop = deferred(),
    entered = deferred();
  f.device.stop = async () => {
    entered.resolve();
    await stop.promise;
  };
  await c.start(request);
  const cancellation = c.cancel();
  await entered.promise;
  assert.equal((await f.journal.get('job'))?.state, 'started');
  assert.throws(() => c.reset('job'));
  stop.resolve();
  await cancellation;
  assert.equal((await f.journal.get('job'))?.state, 'cancelled');
  c.reset('job');
});
test('restart leaves uncertain print interrupted and blocks all new device starts', async (t) => {
  const f = await setup(t);
  await f.controller().start(request);
  await f.reopen();
  assert.equal((await f.journal.active())?.state, 'interrupted');
  await assert.rejects(
    f.controller().start({ ...request, requestId: 'other' }),
  );
  assert.equal(f.calls.filter((x) => x === 'start').length, 1);
  assert.equal((await f.journal.active())?.state, 'interrupted');
});
test('failed storage acknowledgement prevents effects and reset cannot erase started job', async (t) => {
  const f = await setup(t),
    c = f.controller();
  await c.start(request);
  await f.journal.close();
  await assert.rejects(c.complete('job'));
  await assert.rejects(c.cancel());
  assert.equal(c.state, 'failed');
  assert.throws(() => c.reset('job'));
  assert.throws(() => f.controller(), /already owned/);
  assert.equal(f.calls.filter((x) => x === 'start').length, 1);
});
test('cancel during preparation drains action before persisting cancellation', async (t) => {
  const f = await setup(t),
    prepared = deferred(),
    release = deferred();
  f.device.prepare = async () => {
    prepared.resolve();
    await release.promise;
  };
  const c = f.controller();
  const start = c.start(request);
  const rejected = assert.rejects(start);
  await prepared.promise;
  const cancel = c.cancel();
  assert.equal((await f.journal.active())?.state, 'reserved');
  release.resolve();
  await Promise.all([rejected, cancel]);
  assert.equal((await f.journal.get('job'))?.state, 'cancelled');
  assert.equal(f.calls.includes('start'), false);
});
test('cancel overlapping durable completion preserves committed safe completion', async (t) => {
  const f = await setup(t),
    c = f.controller();
  await c.start(request);
  const committed = deferred(),
    release = deferred();
  const transition = f.journal.transition.bind(f.journal);
  f.journal.transition = async (...args) => {
    const record = await transition(...args);
    if (args[2] === 'completed') {
      committed.resolve();
      await release.promise;
    }
    return record;
  };
  const complete = c.complete('job');
  const rejected = assert.rejects(complete);
  await committed.promise;
  const cancel = c.cancel();
  release.resolve();
  await Promise.all([rejected, cancel]);
  assert.equal(c.state, 'cancelled');
  assert.equal((await f.journal.get('job'))?.state, 'completed');
  c.reset('job');
});
test('late cancellation commit cannot restore success after deadline and retry reconciles', async (t) => {
  const f = await setup(t);
  const c = new PrintController(
    f.device,
    { maxNozzle: 280, maxBed: 110 },
    { stopMs: 50 },
    { journal: f.journal },
  );
  await c.start(request);
  const committed = deferred(),
    release = deferred();
  const transition = f.journal.transition.bind(f.journal);
  let cancellations = 0;
  f.journal.transition = async (...args) => {
    if (args[2] === 'cancelled') cancellations++;
    const record = await transition(...args);
    if (args[2] === 'cancelled') {
      committed.resolve();
      await release.promise;
    }
    return record;
  };
  const cancelled = assert.rejects(c.cancel(), /timed out/);
  await committed.promise;
  await cancelled;
  assert.equal(c.state, 'failed');
  assert.throws(() => c.reset('job'));
  release.resolve();
  await c.cancel();
  assert.equal(c.state, 'cancelled');
  assert.equal(cancellations, 1);
  c.reset('job');
});
test('restoration exposes interrupted identity without effects and requires stop before next job', async (t) => {
  const f = await setup(t);
  await f.controller().start(request);
  await f.reopen();
  const before = f.calls.length;
  const restored = await PrintController.restore(
    f.device,
    { maxNozzle: 280, maxBed: 110 },
    {},
    { journal: f.journal },
  );
  assert.equal(restored.state, 'interrupted');
  assert.deepEqual(restored.currentRequest, request);
  assert.equal(Object.isFrozen(restored.currentRequest), true);
  assert.equal(f.calls.length, before);
  await assert.rejects(restored.resume());
  await assert.rejects(restored.start({ ...request, requestId: 'next' }));
  assert.throws(() => restored.reset('job'));
  const stopped = deferred(),
    release = deferred();
  f.device.stop = async () => {
    stopped.resolve();
    await release.promise;
  };
  const cancelling = restored.cancel();
  assert.equal(restored.cancel(), cancelling);
  await stopped.promise;
  assert.equal((await f.journal.active())?.state, 'interrupted');
  release.resolve();
  await cancelling;
  assert.equal((await f.journal.get('job'))?.state, 'cancelled');
  restored.reset('job');
  await assert.rejects(restored.start(request), /reconciliation/);
  // A rejected replay still requires its controller's acknowledged cleanup.
  await restored.cancel();
  restored.reset('job');
  f.device.prepare = async () => {};
  await restored.start({ ...request, requestId: 'next' });
  assert.equal(restored.state, 'printing');
  await restored.cancel();
});
test('restore refuses to adopt a live record or hide a closed journal', async (t) => {
  const f = await setup(t);
  await f.controller().start(request);
  const before = f.calls.length;
  await assert.rejects(
    PrintController.restore(
      f.device,
      { maxNozzle: 280, maxBed: 110 },
      {},
      { journal: f.journal },
    ),
    /already owned/,
  );
  assert.equal(f.calls.length, before);
  await f.journal.close();
  await assert.rejects(
    PrintController.restore(
      f.device,
      { maxNozzle: 280, maxBed: 110 },
      {},
      { journal: f.journal },
    ),
  );
});
test('failed recovery stop retains interrupted record for a fresh acknowledged retry', async (t) => {
  const f = await setup(t);
  await f.controller().start(request);
  await f.reopen();
  const restored = await PrintController.restore(
    f.device,
    { maxNozzle: 280, maxBed: 110 },
    {},
    { journal: f.journal },
  );
  f.device.stop = async () => {
    throw new Error('offline');
  };
  await assert.rejects(restored.cancel(), /offline/);
  assert.equal(restored.state, 'failed');
  assert.equal((await f.journal.active())?.state, 'interrupted');
  assert.throws(() => restored.reset('job'));
  f.device.stop = async () => {};
  await restored.cancel();
  restored.reset('job');
  assert.equal(restored.state, 'idle');
});
test('recovery timeout owns late stop and cannot clear interruption before acknowledgement', async (t) => {
  const f = await setup(t);
  await f.controller().start(request);
  await f.reopen();
  const release = deferred();
  let stops = 0, complete = false;
  const started = performance.now(), phases: { phase: string; elapsedMs: number }[] = [];
  const mark = (phase: string) => { if (phases.length < 24) phases.push({ phase, elapsedMs: performance.now() - started }); };
  f.device.stop = async () => {
    stops++;
    mark('device-stop-enter');
    await release.promise;
    mark('device-stop-ack');
  };
  const restored = await PrintController.restore(
    f.device,
    { maxNozzle: 280, maxBed: 110 },
    { stopMs: 30 },
    { journal: f.journal },
  );
  t.after(() => { if (!complete) t.diagnostic('CancelFailurePhases ' + JSON.stringify({ test: 'late-recovery-stop', budgetMs: 30, phases, stateAfterCleanup: restored.state, pendingAfterCleanup: restored.pendingDeviceActions, safeStopPending: restored.safeStopPending, stops, scope: 'Test callback phases; no physical stop latency or event-loop attribution' })); });
  const transition = f.journal.transition.bind(f.journal);
  f.journal.transition = async (...args) => {
    if (args[2] === 'cancelled') mark('cancelled-journal-enter');
    const record = await transition(...args);
    if (args[2] === 'cancelled') mark('cancelled-journal-ack');
    return record;
  };
  mark('first-cancel');
  await assert.rejects(restored.cancel(), /timed out/);
  mark('first-timeout-observed');
  assert.equal((await f.journal.active())?.state, 'interrupted');
  assert.throws(() => restored.reset('job'));
  mark('retry-cancel');
  const retry = restored.cancel();
  mark('device-stop-release');
  release.resolve();
  try { await retry; } catch (error) { mark('retry-rejected'); throw error; }
  mark('retry-completed');
  assert.equal(stops, 1);
  assert.equal((await f.journal.get('job'))?.state, 'cancelled');
  restored.reset('job');
  complete = true;
});
test('restoring a terminal journal yields idle without device calls', async (t) => {
  const f = await setup(t),
    c = f.controller();
  await c.start(request);
  await c.complete('job');
  await f.reopen();
  const before = f.calls.length;
  const restored = await PrintController.restore(
    f.device,
    { maxNozzle: 280, maxBed: 110 },
    {},
    { journal: f.journal },
  );
  assert.equal(restored.state, 'idle');
  assert.equal(restored.currentRequest, undefined);
  assert.equal(f.calls.length, before);
  assert.equal((await f.journal.get('job'))?.state, 'completed');
});
test('one journal cannot be bound to competing controllers even after terminal reset', async (t) => {
  const f = await setup(t),
    controller = f.controller();
  assert.throws(() => f.controller(), /already owned/);
  await controller.start(request);
  assert.throws(() => f.controller(), /already owned/);
  await controller.cancel();
  controller.reset('job');
  assert.throws(() => f.controller(), /already owned/);
  assert.equal(f.calls.filter((x) => x === 'start').length, 1);
});
test('pending restoration claims journal before asynchronous lookup and failed read releases claim', async (t) => {
  const f = await setup(t),
    entered = deferred(),
    release = deferred();
  const active = f.journal.active.bind(f.journal);
  f.journal.active = async () => {
    entered.resolve();
    await release.promise;
    throw new Error('Read unavailable');
  };
  const options = { journal: f.journal };
  const restoring = PrintController.restore(
    f.device,
    { maxNozzle: 280, maxBed: 110 },
    {},
    options,
  );
  const failure = assert.rejects(restoring, /Read unavailable/);
  await entered.promise;
  options.journal = undefined as never;
  assert.throws(() => f.controller(), /already owned/);
  release.resolve();
  await failure;
  assert.deepEqual(f.calls, []);
  f.journal.active = active;
  const controller = await PrintController.restore(
    f.device,
    { maxNozzle: 280, maxBed: 110 },
    {},
    { journal: f.journal },
  );
  await controller.start(request);
  await controller.cancel();
});
test('validation and rejected live-record restoration do not consume journal ownership', async (t) => {
  const f = await setup(t);
  assert.throws(
    () =>
      new PrintController(
        f.device,
        { maxNozzle: -1, maxBed: 110 },
        {},
        { journal: f.journal },
      ),
  );
  await f.journal.reserve(request);
  await assert.rejects(
    PrintController.restore(
      f.device,
      { maxNozzle: 280, maxBed: 110 },
      {},
      { journal: f.journal },
    ),
    /live/,
  );
  // Removing the failed restore's claim is observable without allowing replay.
  const controller = f.controller();
  await assert.rejects(controller.start(request), /reconciliation/);
  assert.equal(f.calls.includes('start'), false);
  assert.equal((await f.journal.get('job'))?.state, 'reserved');
});
test('repeated cancel deadlines reuse the entire stop-and-commit operation', async (t) => {
  const f = await setup(t),
    release = deferred();
  const controller = new PrintController(
    f.device,
    { maxNozzle: 280, maxBed: 110 },
    { stopMs: 30 },
    { journal: f.journal },
  );
  let stops = 0, commits = 0, complete = false;
  const started = performance.now(), phases: { phase: string; elapsedMs: number }[] = [];
  const mark = (phase: string) => { if (phases.length < 32) phases.push({ phase, elapsedMs: performance.now() - started }); };
  t.after(() => { if (!complete) t.diagnostic('CancelFailurePhases ' + JSON.stringify({ test: 'stop-and-commit-reuse', budgetMs: 30, phases, stateAfterCleanup: controller.state, pendingAfterCleanup: controller.pendingDeviceActions, safeStopPending: controller.safeStopPending, stops, commits, scope: 'Test callback phases; no physical stop latency or event-loop attribution' })); });
  f.device.stop = async () => {
    stops++;
    mark('device-stop-ack');
  };
  const transition = f.journal.transition.bind(f.journal);
  f.journal.transition = async (...args) => {
    if (args[2] === 'cancelled') mark('cancelled-journal-enter');
    const record = await transition(...args);
    if (args[2] === 'cancelled') {
      mark('cancelled-journal-durable-ack');
      commits++;
      await release.promise;
      mark('cancelled-journal-owner-release');
    }
    return record;
  };
  await controller.start(request);
  try {
    for (let i = 0; i < 3; i++) {
      mark('expected-timeout-cancel-' + i);
      await assert.rejects(controller.cancel(), /timed out/);
      assert.equal(controller.state, 'failed');
      assert.throws(() => controller.reset('job'));
    }
    assert.equal(stops, 1);
    assert.equal(commits, 1);
  } finally {
    mark('journal-release');
    release.resolve();
  }
  mark('reconcile-cancel');
  try { await controller.cancel(); } catch (error) { mark('reconcile-rejected'); throw error; }
  mark('reconcile-completed');
  assert.equal(stops, 1);
  assert.equal(commits, 1);
  controller.reset('job');
  f.device.prepare = async () => {};
  await controller.start({ ...request, requestId: 'next' });
  assert.equal((await f.journal.get('next'))?.state, 'started');
  mark('next-job-cancel');
  try { await controller.cancel(); } catch (error) { mark('next-job-cancel-rejected'); throw error; }
  mark('next-job-cancel-completed');
  assert.equal(stops, 2);
  assert.equal(commits, 2);
  assert.equal((await f.journal.get('next'))?.state, 'cancelled');
  complete = true;
});
