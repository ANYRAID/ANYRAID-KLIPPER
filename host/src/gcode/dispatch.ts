import {parseCommand,extendedParameters,rawParameters,type ParsedCommand} from './parser.ts';
export class GCodeError extends Error {}
export interface CommandContext extends ParsedCommand {
  signal:AbortSignal;
  rawParameters():string;
  respondInfo(message:string):void;
  respondRaw(message:string):void;
  ack(message?:string):boolean;
}
export type Handler=(command:CommandContext)=>void|Promise<void>;
interface Registration {handler:Handler;extended:boolean;whenNotReady:boolean;checkpoint:boolean;drainBefore:boolean;}
export interface DispatchHooks {
  /** Native product files must not silently skip unimplemented commands. */
  unknownCommand?:'ignore'|'shutdown';
  output(message:string):void;
  drain?(signal:AbortSignal):Promise<void>;
  /** Stream a bounded prefix without forcing a final zero-velocity boundary. */
  checkpoint?(signal:AbortSignal):Promise<void>;
  shutdown(reason:string):void;
  commandError?():void;
}
/** One admission queue. Hardware emergency detection must call emergencyStop directly. */
export class GCodeDispatch {
  #handlers=new Map<string,Registration>();#ready=false;#reason='Printer is not ready';
  #tail:Promise<void>=Promise.resolve();#pending=0;#active:AbortController|undefined;#generation=0;
  #hooks:DispatchHooks;#stopping=false;
  constructor(hooks:DispatchHooks) {this.#hooks=hooks;this.register('M110',()=>{}, {whenNotReady:true});}
  hasCommand(name:string):boolean {return this.#handlers.has(name);}
  register(name:string,handler:Handler,options:{extended?:boolean;whenNotReady?:boolean;checkpoint?:boolean;drainBefore?:boolean}={}):void {
    if(!/^[A-Z_][A-Z0-9_]*$/.test(name)||this.#handlers.has(name))throw new Error('Invalid or duplicate command registration');
    this.#handlers.set(name,{handler,extended:options.extended??!(/^[A-Z][0-9]+$/.test(name)),whenNotReady:options.whenNotReady??false,checkpoint:options.checkpoint??false,drainBefore:options.drainBefore??false});
  }
  setReady(ready:boolean,reason='Printer is not ready'):void {this.#ready=ready;this.#reason=reason;}
  emergencyStop(reason='Shutdown due to M112 command'):void {
    if(this.#stopping)return;this.#stopping=true;
    try{this.#generation++;this.#ready=false;this.#reason=reason;this.#active?.abort(new GCodeError(reason));this.#hooks.shutdown(reason);}
    finally{this.#stopping=false;}
  }
  /** Serial scripts reject at the first command error; acknowledged input continues. */
  execute(script:string,options:{acknowledge?:boolean;boundary?:'drain'|'checkpoint'}={}):Promise<void> {
    return this.#enqueue(script,options).then(()=>{});
  }
  /** Trusted machine lifecycle work shares admission with scripts. The callback
   * owns its motion barriers and must never recursively enqueue dispatch work.
   * Retain ownership until it settles, including after cancellation. */
  runExclusive(work:(signal:AbortSignal)=>Promise<void>,signal:AbortSignal):Promise<void> {
    if(typeof work!=='function'||!(signal instanceof AbortSignal))return Promise.reject(new TypeError('Invalid machine action'));
    if(this.#pending>=64)return Promise.reject(new GCodeError('G-code admission limit'));
    this.#pending++;const generation=this.#generation;
    const job=this.#tail.then(async()=>{
      signal.throwIfAborted();if(generation!==this.#generation)throw new GCodeError('Machine action invalidated by shutdown');
      const controller=new AbortController(),local=AbortSignal.any([signal,controller.signal]);this.#active=controller;
      try{await work(local);local.throwIfAborted();}
      catch(error){if(generation===this.#generation)this.emergencyStop('Machine action failed');throw error;}
      finally{if(this.#active===controller)this.#active=undefined;}
    });
    this.#tail=job.then(()=>{},()=>{}).finally(()=>{this.#pending--;});return job;
  }
  /** Opportunistic lifecycle work never queues behind scripts or other actions.
   * Once admitted it owns the same cancellation and retirement barrier. */
  runWhenIdle(work:(signal:AbortSignal)=>Promise<void>,signal:AbortSignal):Promise<boolean>{
    if(typeof work!=='function'||!(signal instanceof AbortSignal))return Promise.reject(new TypeError('Invalid idle machine action'));
    if(this.#pending)return Promise.resolve(false);
    return this.runExclusive(work,signal).then(()=>true);
  }
  /** Yield before the next command without draining or discarding the suffix.
   * The owner must retain the script and drain admitted motion before parking.
   * onCheckpoint brackets the awaited motion hook, not ordinary handlers;
   * an interrupted hook continues owning dispatch until it actually settles. */
  executePrefix(script:string,shouldContinue:()=>boolean,onCheckpoint?:(active:boolean)=>void):Promise<number> {
    if(typeof shouldContinue!=='function'||onCheckpoint!==undefined&&typeof onCheckpoint!=='function')return Promise.reject(new TypeError('Invalid prefix admission callbacks'));
    return this.#enqueue(script,{boundary:'checkpoint'},shouldContinue,onCheckpoint);
  }
  #enqueue(script:string,options:{acknowledge?:boolean;boundary?:'drain'|'checkpoint'},shouldContinue?:()=>boolean,onCheckpoint?:(active:boolean)=>void):Promise<number> {
    if(script.length>1048576||this.#pending>=64)return Promise.reject(new GCodeError('G-code admission limit'));
    const lines=script.split('\n').map(line=>line.endsWith('\r')?line.slice(0,-1):line);
    if(lines.length>16384)return Promise.reject(new GCodeError('G-code line count limit'));
    this.#pending++;
    const generation=this.#generation;
    const job=this.#tail.then(()=>{
      if(generation!==this.#generation)throw new GCodeError('Script invalidated by shutdown');
      return this.#run(lines,options.acknowledge??false,options.boundary??'drain',shouldContinue,onCheckpoint);
    });
    this.#tail=job.then(()=>{},()=>{}).finally(()=>{this.#pending--;});return job;
  }
  async #run(lines:string[],needAck:boolean,boundary:'drain'|'checkpoint',shouldContinue?:()=>boolean,onCheckpoint?:(active:boolean)=>void):Promise<number> {
    const controller=new AbortController();this.#active=controller;
    try {
      let count=0,completed=0;
      for(const line of lines) {
        controller.signal.throwIfAborted();if(shouldContinue&&!shouldContinue())return completed;
        if(count++&&count%128===0) {
          try{onCheckpoint?.(true);if(this.#hooks.checkpoint)await this.#hooks.checkpoint(controller.signal);else await this.#hooks.drain?.(controller.signal);}
          catch(error){if(!controller.signal.aborted)this.emergencyStop('Motion checkpoint failed');throw error;}
          finally{onCheckpoint?.(false);}
          await new Promise<void>(resolve=>setImmediate(resolve));
          controller.signal.throwIfAborted();if(shouldContinue&&!shouldContinue())return completed;
        }
        let acknowledged=false;
        const ack=(message?:string):boolean=>{
          if(!needAck||acknowledged)return false;
          acknowledged=true;this.#hooks.output(message?'ok '+message:'ok');return true;
        };
        try {
          let parsed:ParsedCommand;
          try{parsed=parseCommand(line);}catch{throw new GCodeError('Invalid G-code line');}
          if(parsed.command==='M112'){this.emergencyStop();controller.signal.throwIfAborted();}
          let registration=this.#handlers.get(parsed.command);
          if(!registration&&this.#ready&&/^(M117|M118|M23)\s/.test(parsed.command)) {
            parsed.command=parsed.command.split(/\s/)[0];registration=this.#handlers.get(parsed.command);
          }
          const context:CommandContext={...parsed,signal:controller.signal,rawParameters:()=>rawParameters(parsed),
            respondRaw:message=>this.#hooks.output(message),respondInfo:message=>this.#hooks.output('// '+message.trim().split('\n').map(s=>s.trim()).join('\n// ')),ack};
          if(!registration&&parsed.command==='M105'&&this.#hooks.unknownCommand!=='shutdown')ack('T:0');
          else if(!registration&&parsed.command==='M21'&&this.#hooks.unknownCommand!=='shutdown'){}
          else {
            if(!this.#ready&&!registration?.whenNotReady)throw new GCodeError(this.#reason);
            if(registration) {
              if(registration.extended)try{context.params=extendedParameters(parsed);}catch{throw new GCodeError(`Malformed command '${parsed.commandline}'`);}
              if(registration.drainBefore){
                // Keep state-changing commands unconsumed while old motion is
                // stopped at a file checkpoint. Resume retries the same line.
                try{onCheckpoint?.(true);await this.#hooks.drain?.(controller.signal);controller.signal.throwIfAborted();}
                catch(error){if(!controller.signal.aborted)this.emergencyStop('Motion barrier failed');throw error;}
                finally{onCheckpoint?.(false);}
                if(shouldContinue&&!shouldContinue())return completed;
              }
              try{if(registration.checkpoint)onCheckpoint?.(true);const result=registration.handler(context);if(result)await result;}finally{if(registration.checkpoint)onCheckpoint?.(false);}
              controller.signal.throwIfAborted();
            } else if(parsed.command){
              if(this.#hooks.unknownCommand==='shutdown'){const reason=`Unsupported command: ${parsed.command}`;this.emergencyStop(reason);throw new GCodeError(reason);}
              context.respondInfo(`Unknown command:"${parsed.command}"`);
            }
          }
        }catch(error) {
          const expected=error instanceof GCodeError;
          const message=expected?error.message:'Internal error processing G-code';
          if(!expected&&!controller.signal.aborted)this.emergencyStop(message);
          this.#hooks.output('!! '+message.split('\n')[0].trim());this.#hooks.commandError?.();
          if(!needAck||controller.signal.aborted)throw error;
        }
        ack();completed++;
      }
      controller.signal.throwIfAborted();if(shouldContinue&&!shouldContinue())return completed;
      try{onCheckpoint?.(true);if(boundary==='checkpoint'&&this.#hooks.checkpoint)await this.#hooks.checkpoint(controller.signal);else await this.#hooks.drain?.(controller.signal);controller.signal.throwIfAborted();}
      catch(error){if(!controller.signal.aborted)this.emergencyStop('Motion drain failed');throw error;}
      finally{onCheckpoint?.(false);}
      return completed;
    }finally{if(this.#active===controller)this.#active=undefined;}
  }
}
