import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrintController } from '../src/operations/print.ts';
import type { PrintDevice, StartPrint } from '../src/operations/print.ts';
const request: StartPrint = {
  version: 1,
  requestId: 'job1',
  fileId: 'file1',
  nozzle: 210,
  bed: 60,
};
function fixture(overrides: Partial<PrintDevice> = {}) {
  const calls: string[] = [];
  const device: PrintDevice = {
    prepare: async () => {
      calls.push('prepare');
    },
    start: async () => {
      calls.push('start');
    },
    pause: async () => {
      calls.push('pause');
    },
    resume: async () => {
      calls.push('resume');
    },
    finish: async () => {
      calls.push('finish');
    },
    stop: async () => {
      calls.push('stop');
    },
    ...overrides,
  };
  return {
    calls,
    controller: new PrintController(device, { maxNozzle: 280, maxBed: 110 }),
  };
}
test('versioned requests validate temperatures and opaque file IDs before side effects', async () => {
  const { calls, controller } = fixture();
  for (const invalid of [
    { ...request, nozzle: NaN },
    { ...request, nozzle: 281 },
    { ...request, fileId: '../file.gcode' },
    { ...request, bed: -1 },
  ])
    await assert.rejects(controller.start(invalid), /Invalid/);
  assert.deepEqual(calls, []);
  assert.equal(controller.state, 'idle');
});
test('start is idempotent; pause and resume are state constrained', async () => {
  const { calls, controller } = fixture();
  const first = controller.start(request);
  assert.equal(first, controller.start({ ...request }));
  await assert.rejects(controller.start({ ...request, bed: 65 }), /conflicts/);
  await first;
  assert.equal(controller.state, 'printing');
  await controller.pause();
  await controller.pause();
  assert.equal(controller.state, 'paused');
  await controller.resume();
  await controller.cancel();
  assert.deepEqual(calls, ['prepare', 'start', 'pause', 'resume', 'stop']);
  assert.equal(controller.state, 'cancelled');
  await assert.rejects(controller.resume(), /Cannot resume/);
});
test('cancellation during heating cannot start printing or release before safe stop', async () => {
  let prepared: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    prepared = resolve;
  });
  let release: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { controller, calls } = fixture({
    prepare: async (_r, signal) => {
      prepared();
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      );
    },
    stop: async () => {
      await stopped;
    },
  });
  const pending = controller.start(request);
  const rejected = assert.rejects(pending, /cancelled/);
  await entered;
  const cancellation = controller.cancel();
  assert.equal(cancellation, controller.cancel());
  await rejected;
  assert.equal(controller.state, 'cancelling');
  release();
  await cancellation;
  assert.equal(controller.state, 'cancelled');
  assert.deepEqual(calls, []);
});
test('adapter failures attempt safe stop and remain failed', async () => {
  const { controller, calls } = fixture({
    start: async () => {
      throw new Error('Disconnected');
    },
  });
  await assert.rejects(controller.start(request), /Disconnected/);
  assert.equal(controller.state, 'failed');
  assert.deepEqual(calls, ['prepare', 'stop']);
  await assert.rejects(
    controller.start({ ...request, requestId: 'job2' }),
    /Cannot start/,
  );
});

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const limits = { maxNozzle: 280, maxBed: 110 };
const shortDeadlines = { startMs: 25, pauseMs: 25, resumeMs: 25, stopMs: 25 };
function deviceWith(overrides: Partial<PrintDevice>): PrintDevice {
  return {
    prepare: async () => {},
    start: async () => {},
    pause: async () => {},
    resume: async () => {},
    finish: async () => {},
    stop: async () => {},
    ...overrides,
  };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
test('late preparation cannot start printing; timeout retains ownership and reasserts stop after it settles', async () => {
  const entered = deferred(),
    late = deferred(),
    stops: string[] = [];
  let signal!: AbortSignal,
    starts = 0;
  const controller = new PrintController(
    deviceWith({
      prepare: async (_r, s) => {
        signal = s;
        entered.resolve();
        await late.promise;
        stops.push('late-heat');
      },
      start: async () => {
        starts++;
      },
      stop: async () => {
        stops.push('stop');
      },
    }),
    limits,
    shortDeadlines,
  );
  const running = controller.start(request);
  const rejected = assert.rejects(
    running,
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors[0].name === 'PrintTimeoutError',
  );
  await entered.promise;
  await rejected;
  assert.equal(signal.aborted, true);
  assert.equal(controller.state, 'failed');
  assert.equal(controller.pendingDeviceActions, 1);
  assert.equal(controller.safeStopPending, true);
  assert.deepEqual(stops, ['stop']);
  await assert.rejects(
    controller.start({ ...request, requestId: 'new' }),
    /Cannot start/,
  );
  late.resolve();
  await tick();
  assert.deepEqual(stops, ['stop', 'late-heat', 'stop']);
  assert.equal(starts, 0);
  assert.equal(controller.pendingDeviceActions, 0);
  assert.equal(controller.safeStopPending, false);
  assert.equal(controller.state, 'failed');
  await controller.cancel();
  assert.equal(controller.state, 'cancelled');
});
test('cancel deadline never claims safe cancellation and retries share unsettled stop ownership', async () => {
  const stopped = deferred();
  let stops = 0;
  const controller = new PrintController(
    deviceWith({
      stop: () => {
        stops++;
        return stopped.promise;
      },
    }),
    limits,
    shortDeadlines,
  );
  await controller.start(request);
  await assert.rejects(controller.cancel(), /cancel timed out/);
  assert.equal(controller.state, 'failed');
  assert.equal(controller.safeStopPending, true);
  assert.equal(controller.pendingDeviceActions, 1);
  const retry = controller.cancel();
  assert.equal(retry, controller.cancel());
  assert.equal(stops, 1);
  stopped.resolve();
  await retry;
  assert.equal(controller.state, 'cancelled');
  assert.equal(stops, 1);
  assert.equal(controller.pendingDeviceActions, 0);
});
test('cancel waits for a late effect and a new final stop acknowledgement', async () => {
  const entered = deferred(),
    late = deferred(),
    finalAck = deferred(),
    finalEntered = deferred();
  let stops = 0;
  const effects: string[] = [];
  const controller = new PrintController(
    deviceWith({
      prepare: async () => {
        entered.resolve();
        await late.promise;
        effects.push('late');
      },
      stop: async () => {
        effects.push('stop');
        if (++stops === 2) {
          finalEntered.resolve();
          await finalAck.promise;
        }
      },
    }),
    limits,
    { ...shortDeadlines, stopMs: 1000 },
  );
  const running = controller.start(request),
    rejected = assert.rejects(running, /cancelled/);
  await entered.promise;
  const cancel = controller.cancel();
  await rejected;
  await tick();
  assert.deepEqual(effects, ['stop']);
  late.resolve();
  await finalEntered.promise;
  assert.equal(controller.state, 'cancelling');
  assert.deepEqual(effects, ['stop', 'late', 'stop']);
  finalAck.resolve();
  await cancel;
  assert.equal(controller.state, 'cancelled');
});
test('pause timeout prevents late success and does not permit resume', async () => {
  const entered = deferred(),
    late = deferred();
  let resumes = 0,
    stops = 0;
  const controller = new PrintController(
    deviceWith({
      pause: async () => {
        entered.resolve();
        await late.promise;
      },
      resume: async () => {
        resumes++;
      },
      stop: async () => {
        stops++;
      },
    }),
    limits,
    shortDeadlines,
  );
  await controller.start(request);
  const paused = controller.pause(),
    rejected = assert.rejects(paused, AggregateError);
  await entered.promise;
  await rejected;
  assert.equal(controller.state, 'failed');
  await assert.rejects(controller.resume(), /Cannot resume/);
  late.resolve();
  await tick();
  assert.equal(controller.state, 'failed');
  assert.equal(resumes, 0);
  assert.equal(stops, 2);
});
test('failed stop may be retried without restoring print execution', async () => {
  let stops = 0;
  const controller = new PrintController(
    deviceWith({
      stop: async () => {
        if (++stops === 1) throw new Error('stop failed');
      },
    }),
    limits,
    shortDeadlines,
  );
  await controller.start(request);
  await assert.rejects(controller.cancel(), /stop failed/);
  assert.equal(controller.state, 'failed');
  await controller.cancel();
  assert.equal(stops, 2);
  assert.equal(controller.state, 'cancelled');
  await assert.rejects(controller.resume(), /Cannot resume/);
});
test('operation deadlines validate before any adapter effects', () => {
  for (const value of [0, -1, NaN, Infinity, 1.5, 86400001])
    assert.throws(
      () => new PrintController(deviceWith({}), limits, { startMs: value }),
      /Invalid print deadline/,
    );
});

test('cancellation and failure cleanup share one in-flight stop', async () => {
  const entered = deferred(),
    ack = deferred();
  let stops = 0;
  const controller = new PrintController(
    deviceWith({
      pause: async () => {
        throw new Error('pause lost');
      },
      stop: async () => {
        stops++;
        entered.resolve();
        await ack.promise;
      },
    }),
    limits,
    { ...shortDeadlines, stopMs: 1000 },
  );
  await controller.start(request);
  const paused = controller.pause(),
    rejected = assert.rejects(paused, /pause lost/);
  await entered.promise;
  const cancellation = controller.cancel();
  await tick();
  assert.equal(stops, 1);
  ack.resolve();
  await rejected;
  await cancellation;
  assert.equal(controller.state, 'cancelled');
  assert.equal(stops, 1);
});
test('resume timeout and late start cannot restore a successful state', async () => {
  for (const operation of ['start', 'resume'] as const) {
    const entered = deferred(),
      late = deferred();
    const effects: string[] = [];
    const controller = new PrintController(
      deviceWith({
        [operation]: async () => {
          entered.resolve();
          await late.promise;
          effects.push('late-' + operation);
        },
        stop: async () => {
          effects.push('stop');
        },
      }),
      limits,
      shortDeadlines,
    );
    let active: Promise<void>;
    if (operation === 'start') active = controller.start(request);
    else {
      await controller.start(request);
      await controller.pause();
      active = controller.resume();
    }
    const rejected = assert.rejects(active, AggregateError);
    await entered.promise;
    await rejected;
    assert.equal(controller.state, 'failed');
    late.resolve();
    await tick();
    assert.deepEqual(effects, ['stop', 'late-' + operation, 'stop']);
    assert.equal(controller.state, 'failed');
  }
});
test('immediate cancellation cannot enter preparation after abort', async () => {
  let prepared = 0,
    stops = 0;
  const controller = new PrintController(
    deviceWith({
      prepare: async () => {
        prepared++;
      },
      stop: async () => {
        stops++;
      },
    }),
    limits,
    shortDeadlines,
  );
  const running = controller.start(request),
    rejected = assert.rejects(running, /cancelled/);
  await controller.cancel();
  await rejected;
  assert.equal(prepared, 0);
  assert.equal(stops, 1);
  assert.equal(controller.state, 'cancelled');
});

test('final stop rejection cannot report cancellation success', async () => {
  const entered = deferred(),
    late = deferred();
  let stops = 0;
  const controller = new PrintController(
    deviceWith({
      prepare: async () => {
        entered.resolve();
        await late.promise;
      },
      stop: async () => {
        if (++stops === 2) throw new Error('final stop lost');
      },
    }),
    limits,
    { ...shortDeadlines, stopMs: 1000 },
  );
  const running = controller.start(request),
    rejected = assert.rejects(running, /cancelled/);
  await entered.promise;
  const cancel = controller.cancel(),
    failed = assert.rejects(cancel, /final stop lost/);
  await rejected;
  late.resolve();
  await failed;
  assert.equal(controller.state, 'failed');
  assert.equal(stops, 2);
  await controller.cancel();
  assert.equal(controller.state, 'cancelled');
  assert.equal(stops, 3);
});
test('runtime request shapes cannot coerce identifiers or bypass validation', async () => {
  const { controller, calls } = fixture();
  for (const value of [
    null,
    undefined,
    [],
    { ...request, fileId: 123 },
    { ...request, requestId: 123 },
  ])
    await assert.rejects(
      controller.start(value as unknown as StartPrint),
      /Invalid print request/,
    );
  assert.deepEqual(calls, []);
  assert.equal(controller.state, 'idle');
});

test('abort listener reentry observes the same cancellation promise', async () => {
  const entered = deferred();
  let nested: Promise<void> | undefined;
  let controller!: PrintController;
  controller = new PrintController(
    deviceWith({
      prepare: async (_r, signal) => {
        entered.resolve();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              nested = controller.cancel();
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
    }),
    limits,
    shortDeadlines,
  );
  const running = controller.start(request),
    rejected = assert.rejects(running, /cancelled/);
  await entered.promise;
  const cancel = controller.cancel();
  assert.equal(nested, cancel);
  await rejected;
  await cancel;
  assert.equal(controller.state, 'cancelled');
});

test('normal completion waits for drained motion acknowledgement and does not cancel queued moves', async () => {
  const entered = deferred(),
    ack = deferred();
  let finishes = 0,
    stops = 0;
  const controller = new PrintController(
    deviceWith({
      finish: async (id) => {
        assert.equal(id, request.requestId);
        finishes++;
        entered.resolve();
        await ack.promise;
      },
      stop: async () => {
        stops++;
      },
    }),
    limits,
  );
  await assert.rejects(controller.complete('missing'), /current print/);
  await controller.start(request);
  const completed = controller.complete(request.requestId);
  assert.equal(completed, controller.complete(request.requestId));
  await entered.promise;
  assert.equal(controller.state, 'finishing');
  assert.throws(
    () => controller.reset(request.requestId),
    /terminal device acknowledgement/,
  );
  await assert.rejects(controller.pause(), /Cannot pause/);
  ack.resolve();
  await completed;
  assert.equal(controller.state, 'completed');
  assert.equal(finishes, 1);
  await controller.cancel();
  assert.equal(stops, 0);
  assert.equal(controller.state, 'completed');
});
test('next job keeps old start and completion idempotency without accepting stale effects', async () => {
  const { controller, calls } = fixture();
  const first = controller.start(request);
  await first;
  const completed = controller.complete(request.requestId);
  await completed;
  controller.reset(request.requestId);
  assert.equal(controller.state, 'idle');
  assert.equal(Boolean(controller.currentRequest), false);
  assert.equal(controller.start(request), first);
  await first;
  assert.equal(controller.state, 'idle');
  const next = { ...request, requestId: 'job2', fileId: 'file2' };
  await controller.start(next);
  assert.equal(controller.complete(request.requestId), completed);
  await completed;
  assert.equal(controller.state, 'printing');
  assert.equal(controller.currentRequest?.requestId, 'job2');
  assert.equal(Object.isFrozen(controller.currentRequest), true);
  assert.equal(controller.rememberedRequests, 2);
  await assert.rejects(
    controller.start({ ...request, fileId: 'changed' }),
    /conflicts/,
  );
  assert.deepEqual(calls, ['prepare', 'start', 'finish', 'prepare', 'start']);
  await controller.cancel();
  controller.reset('job2');
  await assert.rejects(controller.complete('job2'), /current print/);
});
test('bounded history never evicts an old request to make it executable again', async () => {
  let starts = 0;
  const controller = new PrintController(
    deviceWith({
      start: async () => {
        starts++;
      },
    }),
    limits,
    {},
    { maxRememberedRequests: 2 },
  );
  const first = controller.start(request);
  await first;
  await controller.cancel();
  controller.reset(request.requestId);
  await controller.start({ ...request, requestId: 'job2' });
  await controller.complete('job2');
  assert.throws(() => controller.reset(request.requestId), /current print/);
  controller.reset('job2');
  controller.reset('job2');
  await assert.rejects(
    controller.start({ ...request, requestId: 'job3' }),
    /history capacity/,
  );
  assert.equal(controller.start(request), first);
  assert.equal(starts, 2);
  assert.equal(controller.state, 'idle');
  assert.equal(controller.rememberedRequests, 2);
  for (const limit of [0, -1, NaN, Infinity, 1.5, 65537])
    assert.throws(
      () =>
        new PrintController(
          deviceWith({}),
          limits,
          {},
          { maxRememberedRequests: limit },
        ),
      /history limit/,
    );
});
test('cancel during completion waits for the late finisher and final stop, then permits a new job', async () => {
  const entered = deferred(),
    late = deferred(),
    final = deferred(),
    finalEntered = deferred();
  let stops = 0;
  const controller = new PrintController(
    deviceWith({
      finish: async () => {
        entered.resolve();
        await late.promise;
      },
      stop: async () => {
        if (++stops === 2) {
          finalEntered.resolve();
          await final.promise;
        }
      },
    }),
    limits,
    { stopMs: 1000 },
  );
  await controller.start(request);
  const completed = controller.complete(request.requestId),
    rejected = assert.rejects(completed, /cancelled/);
  await entered.promise;
  const cancel = controller.cancel();
  await rejected;
  late.resolve();
  await finalEntered.promise;
  assert.equal(controller.state, 'cancelling');
  assert.throws(() => controller.reset(request.requestId));
  final.resolve();
  await cancel;
  controller.reset(request.requestId);
  await controller.start({ ...request, requestId: 'job2' });
  assert.equal(controller.state, 'printing');
  await assert.rejects(controller.complete(request.requestId), /cancelled/);
  assert.equal(controller.state, 'printing');
  await controller.cancel();
});
test('completion verification failure and deadline cannot be acknowledged as successful jobs', async () => {
  const missing = new PrintController(
    deviceWith({
      finish: async () => {
        throw new Error('EOF not verified');
      },
    }),
    limits,
  );
  await missing.start(request);
  await assert.rejects(missing.complete(request.requestId), /EOF not verified/);
  assert.equal(missing.state, 'failed');
  assert.throws(() => missing.reset(request.requestId));
  await missing.cancel();
  missing.reset(request.requestId);
  const late = deferred();
  let stops = 0;
  const controller = new PrintController(
    deviceWith({
      finish: () => late.promise,
      stop: async () => {
        stops++;
      },
    }),
    limits,
    { finishMs: 25, stopMs: 25 },
  );
  await controller.start(request);
  await assert.rejects(
    controller.complete(request.requestId),
    (error: unknown) =>
      error instanceof AggregateError && error.errors[0].operation === 'finish',
  );
  assert.equal(controller.state, 'failed');
  assert.throws(() => controller.reset(request.requestId));
  late.resolve();
  await tick();
  assert.equal(stops, 2);
  assert.equal(controller.state, 'failed');
  await controller.cancel();
  controller.reset(request.requestId);
  assert.equal(controller.state, 'idle');
});
test('adapters lacking a completion acknowledgement are rejected before printing', () => {
  const device = deviceWith({});
  delete (device as Partial<PrintDevice>).finish;
  assert.throws(
    () => new PrintController(device, limits),
    /Incomplete print device adapter/,
  );
});

test('remembered requests contain only immutable versioned fields', async () => {
  let received: Readonly<StartPrint> | undefined;
  const controller = new PrintController(
    deviceWith({
      prepare: async (value) => {
        received = value;
      },
    }),
    limits,
  );
  const input = { ...request, extra: { script: 'untrusted metadata' } };
  const running = controller.start(input);
  input.fileId = 'changed';
  await running;
  assert.deepEqual(received, request);
  assert.equal(Object.isFrozen(received), true);
  assert.deepEqual(controller.currentRequest, request);
  await controller.cancel();
  controller.reset(request.requestId);
  assert.equal(controller.rememberedRequests, 1);
});
