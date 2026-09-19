/** Product-facing print lifecycle; adapters enforce limits again at the device boundary. */
export type PrintState='idle'|'preparing'|'printing'|'pausing'|'paused'|'resuming'|'cancelling'|'cancelled'|'failed';
export interface StartPrint {
  version:1;
  requestId:string;
  fileId:string;
  nozzle:number;
  bed:number;
}
export interface PrintDevice {
  /** All methods resolve only after the device acknowledges the action. */
  prepare(request:Readonly<StartPrint>,signal:AbortSignal):Promise<void>;
  start(fileId:string,signal:AbortSignal):Promise<void>;
  pause(signal:AbortSignal):Promise<void>;
  resume(signal:AbortSignal):Promise<void>;
  /** Must stop queued motion and heating, and acknowledge the safe state. */
  stop():Promise<void>;
}
export interface PrintLimits { maxNozzle:number; maxBed:number; }
export class PrintController {
  #device:PrintDevice;
  #limits:PrintLimits;
  #state:PrintState='idle';
  #active:Promise<void>|undefined;
  #abort:AbortController|undefined;
  #cancel:Promise<void>|undefined;
  #start:StartPrint|undefined;
  #startPromise:Promise<void>|undefined;
  get state():PrintState { return this.#state; }
  constructor(device:PrintDevice,limits:PrintLimits) {
    if(!Number.isFinite(limits.maxNozzle) || limits.maxNozzle<=0 || !Number.isFinite(limits.maxBed) || limits.maxBed<=0)
      throw new RangeError('Invalid device temperature limits');
    this.#device=device; this.#limits={...limits};
  }
  start(input:StartPrint):Promise<void> {
    // Validate all user parameters before acquiring a device or causing effects.
    if(input.version!==1 || !/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId) || !/^[A-Za-z0-9_-]{1,128}$/.test(input.fileId)
      || !Number.isFinite(input.nozzle) || input.nozzle<0 || input.nozzle>this.#limits.maxNozzle
      || !Number.isFinite(input.bed) || input.bed<0 || input.bed>this.#limits.maxBed)
      return Promise.reject(new RangeError('Invalid print request'));
    if(this.#start?.requestId===input.requestId) {
      if(this.#start.fileId!==input.fileId || this.#start.nozzle!==input.nozzle || this.#start.bed!==input.bed)
        return Promise.reject(new Error('Idempotency key conflicts with previous request'));
      return this.#startPromise!;
    }
    if(this.#state!=='idle') return Promise.reject(new Error(`Cannot start while ${this.#state}`));
    this.#start=Object.freeze({...input});
    this.#startPromise=this.#run('preparing','printing',async signal => {
      await this.#device.prepare(this.#start!,signal);
      signal.throwIfAborted();
      await this.#device.start(this.#start!.fileId,signal);
    });
    return this.#startPromise;
  }
  pause():Promise<void> {
    if(this.#state==='paused') return Promise.resolve();
    if(this.#state==='pausing') return this.#active!;
    if(this.#state!=='printing' || this.#active) return Promise.reject(new Error(`Cannot pause while ${this.#state}`));
    return this.#run('pausing','paused',signal => this.#device.pause(signal));
  }
  resume():Promise<void> {
    if(this.#state==='resuming') return this.#active!;
    if(this.#state!=='paused' || this.#active) return Promise.reject(new Error(`Cannot resume while ${this.#state}`));
    return this.#run('resuming','printing',signal => this.#device.resume(signal));
  }
  cancel():Promise<void> {
    if(this.#cancel) return this.#cancel;
    if(this.#state==='idle' || this.#state==='cancelled') return Promise.resolve();
    this.#state='cancelling';
    this.#abort?.abort(new Error('Print cancelled'));
    const active=this.#active;
    // Retain cancellation lock through adapter quiescence and safe-stop acknowledgement.
    this.#cancel=(async() => {
      try {
        // Ask for safe stop immediately even if the interrupted adapter is slow.
        const results=await Promise.allSettled([active,Promise.resolve().then(()=>this.#device.stop())]);
        if(results[1].status==='rejected') throw results[1].reason;
        this.#state='cancelled';
      } catch(error) { this.#state='failed'; throw error; }
    })();
    return this.#cancel;
  }
  #run(transient:PrintState,success:PrintState,action:(signal:AbortSignal)=>Promise<void>):Promise<void> {
    this.#state=transient;
    const abort=new AbortController(); this.#abort=abort;
    this.#active=(async() => {
      // Run on a microtask so synchronous adapter failures cannot race slot assignment.
      await Promise.resolve();
      try {
        abort.signal.throwIfAborted();
        await action(abort.signal);
        abort.signal.throwIfAborted();
        this.#state=success;
      } catch(error) {
        if(this.#state!=='cancelling') {
          this.#state='failed';
          try { await this.#device.stop(); }
          catch(stopError) { throw new AggregateError([error,stopError],'Print operation and safe stop failed'); }
        }
        throw error;
      } finally { this.#active=undefined; this.#abort=undefined; }
    })();
    return this.#active;
  }
}
