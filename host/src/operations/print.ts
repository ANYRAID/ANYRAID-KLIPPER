import {randomUUID} from 'node:crypto';
import {ExtrusionAccounting} from '../gcode/extrusion-accounting.ts';
import {PrintStateStream} from './print-state-stream.ts';
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
  /** Checked before reservation and again before preparation/file execution. */
  beforeStart?:()=>void;
  /** Synchronous product interlock; rejection retains the confirmed pause. */
  beforeResume?:()=>void;
  extrusionAccounting?:ExtrusionAccounting;
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
// Release only after permanent retirement has drained all writes and actions.
const journalOwners = new WeakSet<PrintJournal>();
export class PrintController {
  #beforeStart:(()=>void)|undefined;
  #beforeResume:(()=>void)|undefined;
  #extrusionAccounting:ExtrusionAccounting|undefined;
  get filamentUsed():number|null{return this.#extrusionAccounting?.filamentUsed??null;}
  get printDuration():number|null{return this.#extrusionAccounting?.printDuration??null;}
  #retirement:Promise<void>|undefined;
  #historySubscriptions=new Set<()=>void>();
  /** Permanent owner shutdown. Unlike cancel's observation deadline, completion
   * proves that accepted actions, safety cleanup and journal writes retired.
   * Keep the external journal open until this promise settles. */
  retire():Promise<void>{
    if(this.#retirement)return this.#retirement;
    const done=Promise.withResolvers<void>();this.#retirement=done.promise;
    this.#maintenanceGate?.invalidate();
    this.#eofPending=undefined;const errors=this.#detachDevice();for(const release of [...this.#historySubscriptions])release();
    for(const observer of [...this.#stateObservers])void observer.return();
    // Retirement is not a user cancellation: retain an already failed outcome.
    const cancelled=this.#state==='failed'?Promise.resolve():this.#cancelOwned();void cancelled.catch(()=>{});
    void (async()=>{
      // cancel publishes its underlying task on the next microtask. Retain
      // that task, not its possibly timed-out user-facing observation promise.
      await Promise.resolve();
      const cancellation=this.#cancelTask?.promise??cancelled;
      const safety=this.#ensureStopped(),active=this.#active,fault=this.#faultStop;
      const [cancelResult,stopResult]=await Promise.allSettled([cancellation,safety,active,fault]);
      for(const result of [cancelResult,stopResult])if(result.status==='rejected')errors.push(result.reason);
      // User-visible cancellation/fault observations may still update state.
      await Promise.allSettled([cancelled,this.#faultStop]);
      if(errors.length)throw new AggregateError([...new Set(errors)],'Print retirement failed');
      if(this.#journal)journalOwners.delete(this.#journal);
    })().then(done.resolve,done.reject);
    return done.promise;
  }
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
    if(!this.#eofPending||this.#active||this.#preparationPause||this.#state!=='printing'||this.#faultStop)return;
    const requestId=this.#eofPending;this.#eofPending=undefined;
    void this.complete(requestId).catch(()=>{});
  }
  #faultStop:Promise<void>|undefined;#faultCause:unknown;#operationError:unknown;
  get failure():unknown{return this.#faultCause??this.#operationError;}
  /** Latch an asynchronous device fault and await the same safety cleanup. */
  fault(cause:unknown):Promise<void>{
    if(this.#retirement)return this.#retirement;
    if(this.#faultStop)return this.#faultStop;
    const deferred=Promise.withResolvers<void>();this.#faultStop=deferred.promise;
    this.#eofPending=undefined;this.#faultCause=cause;this.#changeState('failed');
    this.#abort?.abort(cause);
    void Promise.resolve().then(()=>printDeadline(this.#ensureStopped(),'safe stop',this.#deadlines.stopMs)).then(()=>this.#persist('failed')).then(deferred.resolve,deferred.reject);
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
  subscribeHistory(listener:(event:import('./print-journal-types.ts').JournalHistoryEvent)=>void){if(this.#retirement)throw new Error('Print controller retired');if(!this.#journal)throw new Error('History requires a durable journal');const undo=this.#journal.subscribeHistory(listener),release=()=>{undo();this.#historySubscriptions.delete(release);};this.#historySubscriptions.add(release);return release;}
  historyList(query:import('./print-journal-types.ts').JournalHistoryQuery){if(!this.#journal)throw new Error('History requires a durable journal');return this.#journal.historyList(query);}
  historyGet(id:string){if(!this.#journal)throw new Error('History requires a durable journal');return this.#journal.historyGet(id);}
  historyDelete(id:string,all=false){if(this.#retirement)throw new Error('Print controller retired');if(!this.#journal)throw new Error('History requires a durable journal');return this.#journal.historyDelete(id,all);}
  historyTotals(){if(!this.#journal)throw new Error('History requires a durable journal');return this.#journal.historyTotals();}
  historyResetTotals(){if(this.#retirement)throw new Error('Print controller retired');if(!this.#journal)throw new Error('History requires a durable journal');return this.#journal.historyResetTotals();}
  get durable():boolean{return !!this.#journal;}
  usesJournal(journal:PrintJournal):boolean{return this.#journal===journal;}
  usesMaintenanceGate(gate:MaintenanceGate):boolean{return this.#maintenanceGate===gate;}
  get rememberedRequests(): number {
    return this.#history.size;
  }
  get currentRequest(): Readonly<StartPrint> | undefined {
    return this.#start;
  }
  readonly #fileMutations=new Set<string>();
  #fileMutationAdmissions=0;
  /** Synchronous admission shared with start(): unrelated files remain mutable
   * during printing, but a pending mutation excludes starting that same file. */
  beginFileMutation(fileId:string):()=>void{
    return this.beginFileMutations([fileId]);
  }
  /** One directory mutation acquires every affected identity atomically. The
   * admission limit counts operations, not the number of files in a directory. */
  beginFileMutations(fileIds:readonly string[]):()=>void{
    if(!Array.isArray(fileIds)||fileIds.length>10000||fileIds.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(id))||new Set(fileIds).size!==fileIds.length)throw new Error('Invalid file identifiers');
    if(this.#retirement||this.#fileMutationAdmissions>=64||fileIds.some(id=>this.#fileMutations.has(id)))throw new Error('File mutation unavailable');
    if(this.#start&&fileIds.includes(this.#start.fileId)&&(!['idle','completed','cancelled'].includes(this.#state)||this.#active||this.#pendingActions.size||this.#stopInFlight||this.#safety||this.#journalWrite||this.#cancelTask?.pending))throw new Error('Current print still owns this file');
    const activity=this.#maintenanceGate?.activity(),ids=[...fileIds];for(const id of ids)this.#fileMutations.add(id);this.#fileMutationAdmissions++;let released=false;
    return ()=>{if(!released){released=true;for(const id of ids)this.#fileMutations.delete(id);this.#fileMutationAdmissions--;activity?.();}};
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
  readonly #stateEpoch=randomUUID();#stateRevision=0n;#stateToken=this.#stateEpoch+':0';
  get stateToken():string{return this.#stateToken;}
  readonly #stateObservers=new Set<PrintStateStream>();
  get stateObservers():number{return this.#stateObservers.size;}
  /** Bounded live state feed. Slow readers get the latest unread state. */
  watchState(signal:AbortSignal):AsyncIterableIterator<import('./print-state-stream.ts').PrintStateChange>{
    if(this.#retirement)throw new Error('Print controller retired');
    signal.throwIfAborted();if(this.#stateObservers.size>=64)throw new Error('Print state observer capacity exceeded');
    const stream=new PrintStateStream(Object.freeze({state:this.#state,stateToken:this.#stateToken}),signal,()=>this.#stateObservers.delete(stream));
    this.#stateObservers.add(stream);return stream;
  }
  #durationStart:number|undefined;
  #duration:number|null=0;
  #freezeStatistics():void{
    this.#extrusionAccounting?.setActive(false);
    if(this.#durationStart!==undefined){this.#duration=this.totalDuration;this.#durationStart=undefined;}
  }
  /** Elapsed job seconds, including preparation and pauses. Unknown after
   * journal restoration: monotonic timestamps cannot survive process restart. */
  get totalDuration():number|null{return this.#durationStart===undefined?this.#duration:Math.max(0,(performance.now()-this.#durationStart)/1000);}
  #changeState(state:PrintState,renew=false):void{
    if(this.#state===state&&!renew)return;
    if(state==='preparing'){if(this.#state!=='preparing')this.#extrusionAccounting?.begin();}
    else if(state==='idle')this.#extrusionAccounting?.reset();
    else if(state==='interrupted')this.#extrusionAccounting?.restoreUnknown();
    // Cancellation preserves whether motion was already active: cancelling a
    // paused or faulted job must not restart extrusion/time accounting.
    else if(state!=='cancelling')this.#extrusionAccounting?.setActive(['printing','pausing','finishing'].includes(state)&&this.#state!=='failed'&&this.#state!=='interrupted');
    if(state==='preparing'&&this.#state!=='preparing'){this.#durationStart=performance.now();this.#duration=0;}
    else if(state==='idle'||state==='interrupted'){this.#durationStart=undefined;this.#duration=state==='idle'?0:null;}
    else if(state==='completed'||state==='cancelled'||state==='failed')this.#freezeStatistics();
    this.#state=state;this.#stateToken=this.#stateEpoch+':'+(++this.#stateRevision);
    if(this.#stateObservers.size){const change=Object.freeze({state,stateToken:this.#stateToken});for(const observer of this.#stateObservers)observer.publish(change);}
  }
  #active: Promise<void> | undefined;
  #abort: AbortController | undefined;
  #cancel: Promise<void> | undefined;
  #cancelTask: { promise: Promise<void>; pending: boolean } | undefined;
  #start: StartPrint | undefined;
  #startPromise: Promise<void> | undefined;
  #preparationPause: Promise<void> | undefined;
  #holdBeforeFile = false;
  #preparedHold = false;
  get pausePending():boolean{return !!this.#preparationPause&&(this.#state==='preparing'||this.#state==='printing'||this.#state==='pausing');}
  get pausedBeforeFile():boolean{return this.#preparedHold&&this.#state==='paused';}
  get state(): PrintState {
    return this.#state;
  }
  constructor(
    device: PrintDevice,
    limits: PrintLimits,
    deadlines: Partial<PrintDeadlines> = {},
    options: PrintControllerOptions = {},
  ) {
    if(options.beforeStart!==undefined&&typeof options.beforeStart!=='function')throw new TypeError('Invalid start interlock');this.#beforeStart=options.beforeStart;
    if(options.beforeResume!==undefined&&typeof options.beforeResume!=='function')throw new TypeError('Invalid resume interlock');
    this.#beforeResume=options.beforeResume;
    if(options.extrusionAccounting!==undefined&&!(options.extrusionAccounting instanceof ExtrusionAccounting))throw new TypeError('Invalid extrusion accounting owner');
    this.#extrusionAccounting=options.extrusionAccounting;
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
        controller.#changeState('interrupted');
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
    if(this.#retirement)return Promise.reject(new Error('Print controller retired'));
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
    if(this.#fileMutations.has(input.fileId))return Promise.reject(new Error('Print file is being modified'));
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
    try{this.#beforeStart?.();}catch(error){return Promise.reject(error);}
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
      () => this.#preparedHold ? 'paused' : 'printing',
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
        this.#beforeStart?.();
        admission.resolve();
        await this.#device.prepare(this.#start!, signal);
        signal.throwIfAborted();
        this.#beforeStart?.();
        // Preparation is acknowledged, but no file command has been admitted.
        // A requested pause holds this sealed job until an explicit resume.
        if(this.#holdBeforeFile){this.#preparedHold=true;return;}
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
    if(this.#retirement)return Promise.reject(new Error('Print controller retired'));
    if(this.#state==='preparing'){
      if(this.#preparationPause)return this.#preparationPause;
      const request=this.#start!;
      this.#holdBeforeFile=true;this.#changeState('preparing',true);
      // Keep the original bounded preparation and its stop owner. Do not run a
      // concurrent device.pause against homing/heating or replay preparation.
      const paused=this.#startPromise!.then(()=>{
        if(this.#start!==request||this.#retirement||this.#cancel||this.#faultStop)throw new Error('Preparation pause invalidated');
        if(this.#state==='paused'&&this.#preparedHold)return;
        // The request may arrive after the file-start checkpoint. Serialize
        // the ordinary acknowledged pause after that start, including EOF.
        if(this.#state==='printing')return this.pause();
        throw new Error('Preparation pause invalidated');
      });
      this.#preparationPause=paused;
      const release=()=>{if(this.#preparationPause===paused)this.#preparationPause=undefined;this.#finishEOF();};
      void paused.then(release,release);return paused;
    }
    if (this.#state === 'paused') return Promise.resolve();
    if (this.#state === 'pausing') return this.#active!;
    if (this.#state !== 'printing' || this.#active)
      return Promise.reject(new Error(`Cannot pause while ${this.#state}`));
    return this.#run('pause', 'pausing', 'paused', (signal) =>
      this.#device.pause(signal),
    );
  }
  resume(): Promise<void> {
    if(this.#retirement)return Promise.reject(new Error('Print controller retired'));
    if (this.#state === 'resuming') return this.#active!;
    if (this.#state !== 'paused' || this.#active)
      return Promise.reject(new Error(`Cannot resume while ${this.#state}`));
    try{this.#beforeResume?.();if(this.#preparedHold)this.#beforeStart?.();}catch(error){return Promise.reject(error);}
    return this.#run('resume', 'resuming', 'printing', async signal => {
      if(!this.#preparedHold)return this.#device.resume(signal);
      signal.throwIfAborted();this.#beforeStart?.();
      await this.#device.start(this.#start!.fileId,signal);signal.throwIfAborted();
      await this.#persist('started');this.#preparedHold=false;
    });
  }
  /** Trusted typed machine action after confirmed pause. The callback must use
   * the paused device owner, never the dispatch held by the paused file.
   * Admission and completion invalidate stale controls without leaving paused.
   * Cancellation/retirement retain the action through normal safety cleanup. */
  adjustPaused(action:(signal:AbortSignal)=>Promise<void>):Promise<void>{
    if(this.#retirement)return Promise.reject(new Error('Print controller retired'));
    if(typeof action!=='function')return Promise.reject(new TypeError('Invalid paused action'));
    if(this.#state!=='paused'||this.#active)return Promise.reject(new Error('Paused action requires an idle confirmed pause'));
    let release:(()=>void)|undefined;try{release=this.#maintenanceGate?.activity();}catch(error){return Promise.reject(error);}
    const pending=this.#run('adjust','paused','paused',action);
    void pending.then(()=>release?.(),()=>release?.());return pending;
  }
  /** Trusted job completion path; the adapter must independently verify EOF. */
  complete(requestId: string): Promise<void> {
    if(this.#retirement)return Promise.reject(new Error('Print controller retired'));
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
    if (this.#state !== 'printing' || this.#active || this.#preparationPause)
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
    if(this.#retirement)throw new Error('Print controller retired');
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
      this.#preparationPause ||
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
    this.#changeState('idle');
    this.#lastReset = requestId;
    this.#start = undefined;
    this.#startPromise = undefined;
    this.#holdBeforeFile=false;this.#preparedHold=false;
    this.#cancel = undefined;
    this.#cancelTask = undefined;
    // Never evict idempotency history silently: a late request must not reprint.
  }
  cancel():Promise<void>{return this.#retirement??this.#cancelOwned();}
  #cancelOwned(): Promise<void> {
    if (this.#cancel) return this.#cancel;
    if (
      this.#state === 'idle' ||
      this.#state === 'cancelled' ||
      this.#state === 'completed'
    )
      return Promise.resolve();
    this.#eofPending=undefined;this.#changeState('cancelling');
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
        this.#changeState('cancelled');
      } catch (error) {
        this.#changeState('failed');
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
  async #persist(state: 'started' | 'completed' | 'cancelled' | 'failed'): Promise<void> {
    // Device acknowledgement precedes this write. Freeze once, so durable and
    // live terminal statistics agree and do not include database commit latency.
    if(state!=='started')this.#freezeStatistics();
    if (this.#journalWrite) {
      await this.#journalWrite;
      return this.#persist(state);
    }
    const record = this.#journalRecord;
    if (!this.#journal || !record) return;
    // Finish may commit while cancellation waits for its underlying action.
    // Its acknowledged safe terminal result must never be overwritten.
    if (['completed', 'cancelled'].includes(record.state)||record.state===state) return;
    if(record.state==='failed'&&state!=='cancelled')return;
    const write = this.#journal
      .transition(record.request.requestId, record.revision, state,state==='started'?undefined:{totalDuration:this.totalDuration,printDuration:this.printDuration,filamentUsed:this.filamentUsed})
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
    operation: 'start' | 'pause' | 'resume' | 'finish' | 'adjust',
    transient: PrintState,
    success: PrintState | (()=>PrintState),
    action: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    this.#changeState(transient,operation==='adjust');
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
          this.#deadlines[operation==='adjust'?'pauseMs':(operation + 'Ms') as keyof PrintDeadlines],
          abort.signal,
          (error) => abort.abort(error),
        );
        abort.signal.throwIfAborted();
        this.#changeState(typeof success==='function'?success():success,operation==='adjust');
      } catch (error) {
        if (this.#state !== 'cancelling') {
          this.#operationError??=error;
          this.#changeState('failed');
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
          await this.#persist('failed');
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
