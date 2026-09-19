import {parseCommand,extendedParameters,rawParameters,type ParsedCommand} from './parser.ts';
export class GCodeError extends Error {}
export interface CommandContext extends ParsedCommand {
  signal:AbortSignal;
  rawParameters():string;
  respondInfo(message:string):void;
  ack(message?:string):boolean;
}
export type Handler=(command:CommandContext)=>void|Promise<void>;
interface Registration {handler:Handler;extended:boolean;whenNotReady:boolean;}
export interface DispatchHooks {
  output(message:string):void;
  drain?():Promise<void>;
  shutdown(reason:string):void;
  commandError?():void;
}
/** One admission queue. Hardware emergency detection must call emergencyStop directly. */
export class GCodeDispatch {
  #handlers=new Map<string,Registration>();#ready=false;#reason='Printer is not ready';
  #tail:Promise<void>=Promise.resolve();#pending=0;#active:AbortController|undefined;#generation=0;
  #hooks:DispatchHooks;
  constructor(hooks:DispatchHooks) {this.#hooks=hooks;this.register('M110',()=>{}, {whenNotReady:true});}
  register(name:string,handler:Handler,options:{extended?:boolean;whenNotReady?:boolean}={}):void {
    if(!/^[A-Z_][A-Z0-9_]*$/.test(name)||this.#handlers.has(name))throw new Error('Invalid or duplicate command registration');
    this.#handlers.set(name,{handler,extended:options.extended??!(/^[A-Z][0-9]+$/.test(name)),whenNotReady:options.whenNotReady??false});
  }
  setReady(ready:boolean,reason='Printer is not ready'):void {this.#ready=ready;this.#reason=reason;}
  emergencyStop(reason='Shutdown due to M112 command'):void {
    this.#generation++;this.#ready=false;this.#reason=reason;this.#active?.abort(new GCodeError(reason));this.#hooks.shutdown(reason);
  }
  /** Serial scripts reject at the first command error; acknowledged input continues. */
  execute(script:string,options:{acknowledge?:boolean}={}):Promise<void> {
    if(script.length>1048576||this.#pending>=64)return Promise.reject(new GCodeError('G-code admission limit'));
    const lines=script.split('\n').map(line=>line.endsWith('\r')?line.slice(0,-1):line);
    if(lines.length>16384)return Promise.reject(new GCodeError('G-code line count limit'));
    this.#pending++;
    const generation=this.#generation;
    const job=this.#tail.then(()=>{
      if(generation!==this.#generation)throw new GCodeError('Script invalidated by shutdown');
      return this.#run(lines,options.acknowledge??false);
    });
    this.#tail=job.catch(()=>{}).finally(()=>{this.#pending--;});return job;
  }
  async #run(lines:string[],needAck:boolean):Promise<void> {
    const controller=new AbortController();this.#active=controller;
    try {
      let count=0;
      for(const line of lines) {
        if(count++&&count%128===0) {
          await this.#hooks.drain?.();
          await new Promise<void>(resolve=>setImmediate(resolve));
        }
        controller.signal.throwIfAborted();let acknowledged=false;
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
            respondInfo:message=>this.#hooks.output('// '+message.trim().split('\n').map(s=>s.trim()).join('\n// ')),ack};
          if(!registration&&parsed.command==='M105')ack('T:0');
          else if(!registration&&parsed.command==='M21'){}
          else {
            if(!this.#ready&&!registration?.whenNotReady)throw new GCodeError(this.#reason);
            if(registration) {
              if(registration.extended)try{context.params=extendedParameters(parsed);}catch{throw new GCodeError(`Malformed command '${parsed.commandline}'`);}
              const result=registration.handler(context);if(result)await result;
              controller.signal.throwIfAborted();
            } else if(parsed.command)context.respondInfo(`Unknown command:"${parsed.command}"`);
          }
        }catch(error) {
          const expected=error instanceof GCodeError;
          const message=expected?error.message:'Internal error processing G-code';
          if(!expected)this.emergencyStop(message);
          this.#hooks.output('!! '+message.split('\n')[0].trim());this.#hooks.commandError?.();
          if(!needAck||controller.signal.aborted)throw error;
        }
        ack();
      }
      await this.#hooks.drain?.();controller.signal.throwIfAborted();
    }finally{if(this.#active===controller)this.#active=undefined;}
  }
}
