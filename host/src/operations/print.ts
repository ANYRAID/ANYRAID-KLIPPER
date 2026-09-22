import {MaintenanceGate} from './maintenance-gate.ts';
import type { PrintJournal, JournalRecord } from './print-journal.ts';
import { printDeadline } from './print-deadline.ts';
/** Product-facing print lifecycle; adapters enforce limits again at the device boundary. */
export type PrintState =
  | 'idle'
  | 'interrupted'
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
  /** Unix milliseconds: admit before this time; not a heating/printing deadline. */
  expiresAt?: number;
}
export interface PrintDevice {
  /** Synchronous fault notification; it must not wait for controller cleanup. */
  subscribeFault?(listener:(cause:unknown)=>void):()=>void;
  /** EOF reports command consumption only; finish must still drain the device. */
  subscribeEOF?(listener:(requestId:string)=>void):()=>void;
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
  maintenanceGate?:MaintenanceGate;
  /** Owned externally; keep open until all device actions and cleanup settle. */
  journal?: PrintJournal;
}
interface PrintRecord {
  request: Readonly<StartPrint>;
  started: Promise<void>;
  admitted: Promise<void>;
  completed?: Promise<void>;
}
// A journal represents one persistent printer owner within this process.
// Never release it on reset/failure: old controller references remain callable.
const journalOwners = new WeakSet<PrintJournal>();
export class PrintController {
  #maintenanceGate:MaintenanceGate|undefined;#removeMaintenanceProbe:(()=>void)|undefined;#restoringMetadata=false;
  #deviceSubscriptions:(()=>void)[]=[];
  #detachDevice():unknown[]{
    this.#removeMaintenanceProbe?.();this.#removeMaintenanceProbe=undefined;
    const errors:unknown[]=[];for(const detach of this.#deviceSubscriptions.splice(0).reverse())try{detach();}catch(error){errors.push(error);}return errors;
  }
  #eofPending:string|undefined;
  #receivedEOF(requestId:string):void{
    if(requestId!==this.#start?.requestId||!['preparing','printing','pausing','paused','resuming'].includes(this.#state))return;
    this.#eofPending=requestId;this.#finishEOF();
  }
  #finishEOF():void{
    if(!this.#eofPending||this.#active||this.#state!=='printing'||this.#faultStop)return;
    const requestId=this.#eofPending;this.#eofPending=undefined;
    void this.complete(requestId).catch(()=>{});
  }
  #faultStop:Promise<void>|undefined;#faultCause:unknown;#operationError:unknown;
  get failure():unknown{return this.#faultCause??this.#operationError;}
  /** Latch an asynchronous device fault and await the same safety cleanup. */
  fault(cause:unknown):Promise<void>{
    if(this.#faultStop)return this.#faultStop;
    const deferred=Promise.withResolvers<void>();this.#faultStop=deferred.promise;
    this.#eofPending=undefined;this.#faultCause=cause;this.#state='failed';
    this.#abort?.abort(cause);
    void Promise.resolve().then(()=>printDeadline(this.#ensureStopped(),'safe stop',this.#deadlines.stopMs)).then(deferred.resolve,deferred.reject);
    return deferred.promise;
  }
  #journal: PrintJournal | undefined;
  #journalRecord: JournalRecord | undefined;
  #journalWrite: Promise<void> | undefined;
  #history = new Map<string, PrintRecord>();
  #historyLimit: number;
  #lastReset: string | undefined;
  /** Read durable request metadata without replaying or changing device state. */
  requestRecord(requestId:string):Promise<JournalRecord|null>{return this.#journal?this.#journal.get(requestId):Promise.resolve(null);}
  get durable():boolean{return !!this.#journal;}
  usesMaintenanceGate(gate:MaintenanceGate):boolean{return this.#maintenanceGate===gate;}
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
  #cancelTask: { promise: Promise<void>; pending: boolean } | undefined;
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
    if(options.maintenanceGate!==undefined&&!(options.maintenanceGate instanceof MaintenanceGate))throw new TypeError('Invalid maintenance gate');this.#maintenanceGate=options.maintenanceGate;
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
    if (options.journal) {
      if (journalOwners.has(options.journal))
        throw new Error('Print journal already owned by a controller');
      journalOwners.add(options.journal);
    }
    this.#journal = options.journal;
    this.#device = device;
    this.#limits = { ...limits };
    try{
      if(device.subscribeFault)this.#deviceSubscriptions.push(device.subscribeFault(cause=>{void this.fault(cause).catch(()=>{});}));
      if(device.subscribeEOF)this.#deviceSubscriptions.push(device.subscribeEOF(requestId=>this.#receivedEOF(requestId)));
      this.#removeMaintenanceProbe=this.#maintenanceGate?.registerIdle(()=>!this.#restoringMetadata&&!this.#faultStop&&['idle','completed','cancelled'].includes(this.#state)&&!this.#active&&!this.#pendingActions.size&&!this.#stopInFlight&&!this.#safety&&!this.#journalWrite&&!this.#cancelTask?.pending);
    }catch(error){
      const cleanup=this.#detachDevice();if(options.journal)journalOwners.delete(options.journal);
      if(cleanup.length)throw new AggregateError([error,...cleanup],'Print subscription rollback failed',{cause:error});throw error;
    }
  }
  /** Restore metadata only. Interrupted jobs require acknowledged cancellation;
   * no heating, movement, homing, or file replay occurs during restoration.
   * An independently reported device fault still initiates safety stop.
   * Caller owns the journal and must provide the uniquely bound device adapter. */
  static async restore(
    device: PrintDevice,
    limits: PrintLimits,
    deadlines: Partial<PrintDeadlines>,
    options: PrintControllerOptions & { journal: PrintJournal },
  ): Promise<PrintController> {
    if (!options?.journal)
      throw new TypeError('Restoration requires a print journal');
    const journal = options.journal;
    const controller = new PrintController(device, limits, deadlines, options);controller.#restoringMetadata=true;
    try {
      const record = await journal.active();
      if(controller.#faultStop)throw new Error('Cannot restore a faulted print device',{cause:controller.#faultCause});
      if (record) {
        if (record.state !== 'interrupted')
          throw new Error('Cannot adopt a live print journal');
        controller.#journalRecord = record;
        controller.#start = Object.freeze({ ...record.request });
        controller.#state = 'interrupted';
      }
      controller.#restoringMetadata=false;return controller;
    } catch (error) {
      // No device action or controller reference escaped failed restoration.
      const cleanup=controller.#detachDevice();journalOwners.delete(journal);
      if(cleanup.length)throw new AggregateError([error,...cleanup],'Print restoration cleanup failed',{cause:error});
      throw error;
    }
  }
  /** Resolves after durable reservation and expiry checks, before waiting for
   * preparation. The controller owns the operation after caller disconnect. */
  admit(input:StartPrint):Promise<void>{
    const started=this.start(input),record=this.#history.get(input?.requestId);
    return record?.started===started?record.admitted:started;
  }
  start(input: StartPrint): Promise<void> {
    if(this.#faultStop)return Promise.reject(new Error('Printer fault requires device reinitialization',{cause:this.#faultCause}));
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
      input.bed > this.#limits.maxBed ||
      input.expiresAt !== undefined && (!Number.isSafeInteger(input.expiresAt) || input.expiresAt < 0)
    )
      return Promise.reject(new RangeError('Invalid print request'));
    const prior = this.#history.get(input.requestId);
    if (prior) {
      if (
        prior.request.fileId !== input.fileId ||
        prior.request.nozzle !== input.nozzle ||
        prior.request.bed !== input.bed ||
        prior.request.expiresAt !== input.expiresAt
      )
        return Promise.reject(
          new Error('Idempotency key conflicts with previous request'),
        );
      return prior.started;
    }
    const expiresAt=input.expiresAt,admittedAt=expiresAt===undefined?0:performance.now(),remaining=expiresAt===undefined?Infinity:expiresAt-Date.now();
    if(remaining<=0)return Promise.reject(new Error('Print request expired before admission'));
    if (this.#state !== 'idle')
      return Promise.reject(new Error(`Cannot start while ${this.#state}`));
    if (this.#history.size >= this.#historyLimit)
      return Promise.reject(
        new Error('Print request history capacity reached'),
      );
    let releaseActivity:()=>void;try{releaseActivity=this.#maintenanceGate?.activity()??(()=>{});}catch(error){return Promise.reject(error);}
    this.#start = Object.freeze({
      version: 1,
      requestId: input.requestId,
      fileId: input.fileId,
      nozzle: input.nozzle,
      bed: input.bed,
      ...(expiresAt===undefined?{}:{expiresAt}),
    });
    const admission=Promise.withResolvers<void>();void admission.promise.catch(()=>{});
    this.#startPromise = this.#run(
      'start',
      'preparing',
      'printing',
      async (signal) => {
        if (this.#journal) {
          const reservation = await this.#journal.reserve(this.#start!);
          if (!reservation.created)
            throw new Error('Persisted print request requires reconciliation');
          this.#journalRecord = reservation.record;
          signal.throwIfAborted();
        }
        // Durable reservation must finish before the first device effect. A
        // wall-clock rollback cannot extend the original admission budget.
        if(expiresAt!==undefined&&(Date.now()>=expiresAt||performance.now()-admittedAt>=remaining))throw new Error('Print request expired before admission');
        admission.resolve();
        await this.#device.prepare(this.#start!, signal);
        signal.throwIfAborted();
        await this.#device.start(this.#start!.fileId, signal);
        signal.throwIfAborted();
        await this.#persist('started');
      },
    );
    void this.#startPromise.then(releaseActivity,error=>{admission.reject(error);releaseActivity();});
    this.#history.set(input.requestId, {
      request: this.#start,
      started: this.#startPromise,
      admitted: admission.promise,
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
    const completed = this.#run(
      'finish',
      'finishing',
      'completed',
      async (signal) => {
        await this.#device.finish(requestId, signal);
        signal.throwIfAborted();
        await this.#persist('completed');
      },
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
      this.#safety ||
      this.#journalWrite ||
      this.#cancelTask?.pending
    )
      throw new Error('Cannot reset before terminal device acknowledgement');
    if (
      this.#journal &&
      this.#journalRecord &&
      !['completed', 'cancelled'].includes(this.#journalRecord.state)
    )
      throw new Error('Cannot reset before durable terminal acknowledgement');
    this.#journalRecord = undefined;this.#operationError=undefined;
    this.#state = 'idle';
    this.#lastReset = requestId;
    this.#start = undefined;
    this.#startPromise = undefined;
    this.#cancel = undefined;
    this.#cancelTask = undefined;
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
    this.#eofPending=undefined;this.#state = 'cancelling';
    const active = this.#active;
    const cancellation = (async () => {
      await Promise.resolve();
      try {
        if (!this.#cancelTask) {
          const pending = Promise.allSettled([active, this.#ensureStopped()]);
          const task = {
            pending: true,
            promise: (async () => {
              const results = await pending;
              if (results[1].status === 'rejected') throw results[1].reason;
              await this.#persist('cancelled');
            })(),
          };
          this.#cancelTask = task;
          task.promise.then(
            () => {
              task.pending = false;
            },
            () => {
              task.pending = false;
              if (this.#cancelTask === task) this.#cancelTask = undefined;
            },
          );
        }
        await printDeadline(
          this.#cancelTask.promise,
          'cancel',
          this.#deadlines.stopMs,
        );
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
  async #persist(state: 'started' | 'completed' | 'cancelled'): Promise<void> {
    if (this.#journalWrite) {
      await this.#journalWrite;
      return this.#persist(state);
    }
    const record = this.#journalRecord;
    if (!this.#journal || !record) return;
    // Finish may commit while cancellation waits for its underlying action.
    // Its acknowledged safe terminal result must never be overwritten.
    if (['completed', 'cancelled'].includes(record.state)) return;
    const write = this.#journal
      .transition(record.request.requestId, record.revision, state)
      .then((updated) => {
        this.#journalRecord = updated;
      });
    this.#journalWrite = write;
    try {
      await write;
    } finally {
      if (this.#journalWrite === write) this.#journalWrite = undefined;
    }
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
          this.#operationError??=error;
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
        this.#finishEOF();
      }
    })();
    return this.#active;
  }
}
