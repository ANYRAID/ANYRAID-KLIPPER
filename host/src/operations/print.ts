import { printDeadline } from './print-deadline.ts';
/** Product-facing print lifecycle; adapters enforce limits again at the device boundary. */
export type PrintState =
  | 'idle'
  | 'preparing'
  | 'printing'
  | 'pausing'
  | 'paused'
  | 'resuming'
  | 'finishing'
  | 'completed'
  | 'cancelling'
  | 'cancelled'
  | 'failed';
export interface StartPrint {
  version: 1;
  requestId: string;
  fileId: string;
  nozzle: number;
  bed: number;
}
export interface PrintDevice {
  /** All methods resolve only after the device acknowledges the action. */
  prepare(request: Readonly<StartPrint>, signal: AbortSignal): Promise<void>;
  start(fileId: string, signal: AbortSignal): Promise<void>;
  pause(signal: AbortSignal): Promise<void>;
  resume(signal: AbortSignal): Promise<void>;
  /** Verify this job reached EOF, drain all remaining motion, and acknowledge
   * final safe heating/output state. Must not discard unexecuted print moves. */
  finish(requestId: string, signal: AbortSignal): Promise<void>;
  /** Idempotent: stop queued motion and heating, acknowledging the safe state.
   * Must be safe to call again after an interrupted action settles. */
  stop(): Promise<void>;
}
export interface PrintLimits {
  maxNozzle: number;
  maxBed: number;
}
export interface PrintDeadlines {
  startMs: number;
  pauseMs: number;
  resumeMs: number;
  stopMs: number;
  finishMs: number;
}
export const defaultPrintDeadlines: Readonly<PrintDeadlines> = Object.freeze({
  startMs: 600000,
  pauseMs: 30000,
  resumeMs: 30000,
  stopMs: 10000,
  finishMs: 30000,
});
export interface PrintControllerOptions {
  maxRememberedRequests?: number;
}
interface PrintRecord {
  request: Readonly<StartPrint>;
  started: Promise<void>;
  completed?: Promise<void>;
}
export class PrintController {
  #history = new Map<string, PrintRecord>();
  #historyLimit: number;
  #lastReset: string | undefined;
  get rememberedRequests(): number {
    return this.#history.size;
  }
  get currentRequest(): Readonly<StartPrint> | undefined {
    return this.#start;
  }
  #device: PrintDevice;
  #deadlines: PrintDeadlines;
  #pendingActions = new Set<Promise<void>>();
  #stopInFlight: Promise<void> | undefined;
  #safety: Promise<void> | undefined;
  get pendingDeviceActions(): number {
    return this.#pendingActions.size + (this.#stopInFlight ? 1 : 0);
  }
  get safeStopPending(): boolean {
    return !!this.#safety;
  }
  #limits: PrintLimits;
  #state: PrintState = 'idle';
  #active: Promise<void> | undefined;
  #abort: AbortController | undefined;
  #cancel: Promise<void> | undefined;
  #start: StartPrint | undefined;
  #startPromise: Promise<void> | undefined;
  get state(): PrintState {
    return this.#state;
  }
  constructor(
    device: PrintDevice,
    limits: PrintLimits,
    deadlines: Partial<PrintDeadlines> = {},
    options: PrintControllerOptions = {},
  ) {
    if (
      !Number.isFinite(limits.maxNozzle) ||
      limits.maxNozzle <= 0 ||
      !Number.isFinite(limits.maxBed) ||
      limits.maxBed <= 0
    )
      throw new RangeError('Invalid device temperature limits');
    this.#historyLimit = options.maxRememberedRequests ?? 1024;
    if (
      !Number.isSafeInteger(this.#historyLimit) ||
      this.#historyLimit < 1 ||
      this.#historyLimit > 65536
    )
      throw new RangeError('Invalid print history limit');
    for (const method of [
      'prepare',
      'start',
      'pause',
      'resume',
      'finish',
      'stop',
    ] as const)
      if (typeof device?.[method] !== 'function')
        throw new TypeError('Incomplete print device adapter');
    this.#deadlines = { ...defaultPrintDeadlines, ...deadlines };
    for (const value of Object.values(this.#deadlines))
      if (!Number.isSafeInteger(value) || value < 1 || value > 86400000)
        throw new RangeError('Invalid print deadline');
    this.#device = device;
    this.#limits = { ...limits };
  }
  start(input: StartPrint): Promise<void> {
    // Validate all user parameters before acquiring a device or causing effects.
    if (
      typeof input !== 'object' ||
      input === null ||
      Array.isArray(input) ||
      input.version !== 1 ||
      typeof input.requestId !== 'string' ||
      typeof input.fileId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.fileId) ||
      !Number.isFinite(input.nozzle) ||
      input.nozzle < 0 ||
      input.nozzle > this.#limits.maxNozzle ||
      !Number.isFinite(input.bed) ||
      input.bed < 0 ||
      input.bed > this.#limits.maxBed
    )
      return Promise.reject(new RangeError('Invalid print request'));
    const prior = this.#history.get(input.requestId);
    if (prior) {
      if (
        prior.request.fileId !== input.fileId ||
        prior.request.nozzle !== input.nozzle ||
        prior.request.bed !== input.bed
      )
        return Promise.reject(
          new Error('Idempotency key conflicts with previous request'),
        );
      return prior.started;
    }
    if (this.#state !== 'idle')
      return Promise.reject(new Error(`Cannot start while ${this.#state}`));
    if (this.#history.size >= this.#historyLimit)
      return Promise.reject(
        new Error('Print request history capacity reached'),
      );
    this.#start = Object.freeze({
      version: 1,
      requestId: input.requestId,
      fileId: input.fileId,
      nozzle: input.nozzle,
      bed: input.bed,
    });
    this.#startPromise = this.#run(
      'start',
      'preparing',
      'printing',
      async (signal) => {
        await this.#device.prepare(this.#start!, signal);
        signal.throwIfAborted();
        await this.#device.start(this.#start!.fileId, signal);
      },
    );
    this.#history.set(input.requestId, {
      request: this.#start,
      started: this.#startPromise,
    });
    return this.#startPromise;
  }
  pause(): Promise<void> {
    if (this.#state === 'paused') return Promise.resolve();
    if (this.#state === 'pausing') return this.#active!;
    if (this.#state !== 'printing' || this.#active)
      return Promise.reject(new Error(`Cannot pause while ${this.#state}`));
    return this.#run('pause', 'pausing', 'paused', (signal) =>
      this.#device.pause(signal),
    );
  }
  resume(): Promise<void> {
    if (this.#state === 'resuming') return this.#active!;
    if (this.#state !== 'paused' || this.#active)
      return Promise.reject(new Error(`Cannot resume while ${this.#state}`));
    return this.#run('resume', 'resuming', 'printing', (signal) =>
      this.#device.resume(signal),
    );
  }
  /** Trusted job completion path; the adapter must independently verify EOF. */
  complete(requestId: string): Promise<void> {
    if (
      typeof requestId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)
    )
      return Promise.reject(new RangeError('Invalid print request identifier'));
    const record = this.#history.get(requestId);
    if (record?.completed) return record.completed;
    if (this.#start?.requestId !== requestId)
      return Promise.reject(
        new Error('Completion does not belong to current print'),
      );
    if (this.#state !== 'printing' || this.#active)
      return Promise.reject(new Error(`Cannot complete while ${this.#state}`));
    const completed = this.#run('finish', 'finishing', 'completed', (signal) =>
      this.#device.finish(requestId, signal),
    );
    record!.completed = completed;
    return completed;
  }
  /** Acknowledges a terminal job locally; does not execute any device action. */
  reset(requestId: string): void {
    if (
      typeof requestId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)
    )
      throw new RangeError('Invalid print request identifier');
    if (this.#state === 'idle' && this.#lastReset === requestId) return;
    if (this.#start?.requestId !== requestId)
      throw new Error('Reset does not belong to current print');
    if (
      !['completed', 'cancelled'].includes(this.#state) ||
      this.#active ||
      this.#pendingActions.size ||
      this.#stopInFlight ||
      this.#safety
    )
      throw new Error('Cannot reset before terminal device acknowledgement');
    this.#state = 'idle';
    this.#lastReset = requestId;
    this.#start = undefined;
    this.#startPromise = undefined;
    this.#cancel = undefined;
    // Never evict idempotency history silently: a late request must not reprint.
  }
  cancel(): Promise<void> {
    if (this.#cancel) return this.#cancel;
    if (
      this.#state === 'idle' ||
      this.#state === 'cancelled' ||
      this.#state === 'completed'
    )
      return Promise.resolve();
    this.#state = 'cancelling';
    const active = this.#active;
    const cancellation = (async () => {
      await Promise.resolve();
      try {
        const pending = Promise.allSettled([active, this.#ensureStopped()]);
        const results = await printDeadline(
          pending,
          'cancel',
          this.#deadlines.stopMs,
        );
        if (results[1].status === 'rejected') throw results[1].reason;
        this.#state = 'cancelled';
      } catch (error) {
        this.#state = 'failed';
        throw error;
      }
    })();
    this.#cancel = cancellation;
    // Failed waits can be retried, but an unsettled stop is never duplicated.
    cancellation.then(
      () => {},
      () => {
        if (this.#cancel === cancellation) this.#cancel = undefined;
      },
    );
    // Publish ownership before invoking potentially reentrant abort listeners.
    this.#abort?.abort(new Error('Print cancelled'));
    return cancellation;
  }
  #track(action: Promise<void>): Promise<void> {
    this.#pendingActions.add(action);
    action.then(
      () => this.#pendingActions.delete(action),
      () => this.#pendingActions.delete(action),
    );
    return action;
  }
  #requestStop(): Promise<void> {
    if (this.#stopInFlight) return this.#stopInFlight;
    const stop = Promise.resolve().then(() => this.#device.stop());
    this.#stopInFlight = stop;
    const release = () => {
      if (this.#stopInFlight === stop) this.#stopInFlight = undefined;
    };
    stop.then(release, release);
    return stop;
  }
  #ensureStopped(): Promise<void> {
    if (this.#safety) return this.#safety;
    const interrupted = [...this.#pendingActions];
    const safety = (async () => {
      // Start the immediate stop before waiting for adapter quiescence.
      const early = this.#requestStop();
      const results = await Promise.allSettled([...interrupted, early]);
      if (interrupted.length) {
        // A late adapter may have changed hardware after the first stop ACK.
        // Reassert the stopped state only after all old actions have settled.
        await this.#requestStop();
      } else {
        const result = results.at(-1)!;
        if (result.status === 'rejected') throw result.reason;
      }
    })();
    this.#safety = safety;
    const release = () => {
      if (this.#safety === safety) this.#safety = undefined;
    };
    safety.then(release, release);
    return safety;
  }
  #run(
    operation: 'start' | 'pause' | 'resume' | 'finish',
    transient: PrintState,
    success: PrintState,
    action: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    this.#state = transient;
    const abort = new AbortController();
    this.#abort = abort;
    this.#active = (async () => {
      await Promise.resolve();
      try {
        abort.signal.throwIfAborted();
        const pending = this.#track(
          Promise.resolve().then(() => {
            abort.signal.throwIfAborted();
            return action(abort.signal);
          }),
        );
        await printDeadline(
          pending,
          operation,
          this.#deadlines[(operation + 'Ms') as keyof PrintDeadlines],
          abort.signal,
          (error) => abort.abort(error),
        );
        abort.signal.throwIfAborted();
        this.#state = success;
      } catch (error) {
        if (this.#state !== 'cancelling') {
          this.#state = 'failed';
          try {
            await printDeadline(
              this.#ensureStopped(),
              'safe stop',
              this.#deadlines.stopMs,
            );
          } catch (stopError) {
            throw new AggregateError(
              [error, stopError],
              'Print operation and safe stop failed',
            );
          }
        }
        throw error;
      } finally {
        this.#active = undefined;
        this.#abort = undefined;
      }
    })();
    return this.#active;
  }
}
