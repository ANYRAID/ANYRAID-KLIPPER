import { printDeadline } from './print-deadline.ts';
/** Product-facing print lifecycle; adapters enforce limits again at the device boundary. */
export type PrintState =
  | 'idle'
  | 'preparing'
  | 'printing'
  | 'pausing'
  | 'paused'
  | 'resuming'
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
}
export const defaultPrintDeadlines: Readonly<PrintDeadlines> = Object.freeze({
  startMs: 600000,
  pauseMs: 30000,
  resumeMs: 30000,
  stopMs: 10000,
});
export class PrintController {
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
  ) {
    if (
      !Number.isFinite(limits.maxNozzle) ||
      limits.maxNozzle <= 0 ||
      !Number.isFinite(limits.maxBed) ||
      limits.maxBed <= 0
    )
      throw new RangeError('Invalid device temperature limits');
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
    if (this.#start?.requestId === input.requestId) {
      if (
        this.#start.fileId !== input.fileId ||
        this.#start.nozzle !== input.nozzle ||
        this.#start.bed !== input.bed
      )
        return Promise.reject(
          new Error('Idempotency key conflicts with previous request'),
        );
      return this.#startPromise!;
    }
    if (this.#state !== 'idle')
      return Promise.reject(new Error(`Cannot start while ${this.#state}`));
    this.#start = Object.freeze({ ...input });
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
  cancel(): Promise<void> {
    if (this.#cancel) return this.#cancel;
    if (this.#state === 'idle' || this.#state === 'cancelled')
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
    operation: 'start' | 'pause' | 'resume',
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
