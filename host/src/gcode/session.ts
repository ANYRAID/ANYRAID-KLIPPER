import type {Readable,Writable} from 'node:stream';
import {GCodeDispatch,GCodeError} from './dispatch.ts';
import {GCodeInput} from './input.ts';
/** Owns a live byte-stream connection; EOF/disconnect always stops admission. */
export class GCodeSession {
  readonly dispatch:GCodeDispatch;
  #input:GCodeInput;#source:Readable;#sink:Writable;#stop:(reason:string)=>void;
  #failure:GCodeError|undefined;#pendingBytes=0;#timer:NodeJS.Timeout|undefined;
  #waiters:{resolve:()=>void;reject:(error:Error)=>void}[]=[];
  #byteLimit:number;#timeout:number;
  constructor(source:Readable,sink:Writable,shutdown:(reason:string)=>void,
    options:{maxOutputBytes?:number;outputTimeoutMs?:number}={}) {
    this.#byteLimit=options.maxOutputBytes??1048576;this.#timeout=options.outputTimeoutMs??5000;
    if(!Number.isSafeInteger(this.#byteLimit)||this.#byteLimit<3||this.#byteLimit>16*1048576
      ||!Number.isFinite(this.#timeout)||this.#timeout<1||this.#timeout>60000)throw new RangeError('Invalid G-code output limits');
    this.#source=source;this.#sink=sink;this.#stop=shutdown;
    this.dispatch=new GCodeDispatch({output:message=>this.#write(message),drain:()=>this.#drain(),shutdown:reason=>this.#terminate(reason)});
    this.#input=new GCodeInput(this.dispatch);
    source.on('data',this.#data);source.on('end',this.#disconnected);source.on('close',this.#disconnected);source.on('error',this.#readError);
    sink.on('error',this.#writeError);sink.on('close',this.#outputClosed);sink.on('finish',this.#outputClosed);
    if(source.destroyed||source.readableEnded||sink.destroyed||sink.writableEnded)this.close('G-code stream already closed');
  }
  get pendingOutputBytes():number{return this.#pendingBytes;}
  get stopped():boolean{return this.#failure!==undefined;}
  #data=(chunk:unknown):void=>{
    if(this.#failure)return;
    if(!(chunk instanceof Uint8Array)){this.close('G-code input must be bytes');return;}
    try{this.#input.receive(chunk);}catch{if(!this.#failure)this.close('G-code input failed');}
  };
  #disconnected=():void=>{this.close('G-code input disconnected');};
  #readError=():void=>{this.close('G-code input read failed');};
  #writeError=():void=>{this.close('G-code output write failed');};
  #outputClosed=():void=>{this.close('G-code output disconnected');};
  close(reason='G-code session closed'):void {if(!this.#failure)this.dispatch.emergencyStop(reason);}
  #terminate(reason:string):void {
    if(this.#failure)return;
    this.#failure=new GCodeError(reason);clearTimeout(this.#timer);this.#timer=undefined;
    for(const waiter of this.#waiters.splice(0))waiter.reject(this.#failure);
    this.#source.removeListener('data',this.#data);
    // Keep error listeners until stream destruction settles; destroy emits asynchronously.
    this.#source.destroy();this.#sink.destroy();this.#pendingBytes=0;
    this.#stop(reason);
  }
  #armTimeout():void {
    clearTimeout(this.#timer);
    if(this.#pendingBytes&&!this.#failure)this.#timer=setTimeout(()=>this.close('G-code output stalled'),this.#timeout);
  }
  #write(message:string):void {
    if(this.#failure)return;
    const bytes=Buffer.byteLength(message)+1;
    if(bytes>this.#byteLimit-this.#pendingBytes){this.close('G-code output buffer limit');throw this.#failure;}
    this.#pendingBytes+=bytes;if(!this.#timer)this.#armTimeout();
    try {
      this.#sink.write(message+'\n',error=>{
        if(this.#failure)return;
        if(error){this.close('G-code output write failed');return;}
        this.#pendingBytes-=bytes;this.#armTimeout();
        if(!this.#pendingBytes){this.#timer=undefined;for(const waiter of this.#waiters.splice(0))waiter.resolve();}
      });
    }catch {this.close('G-code output write failed');throw this.#failure;}
  }
  #drain():Promise<void> {
    if(this.#failure)return Promise.reject(this.#failure);
    if(!this.#pendingBytes)return Promise.resolve();
    return new Promise((resolve,reject)=>this.#waiters.push({resolve,reject}));
  }
  async idle():Promise<void> {await this.#input.idle();await this.#drain();}
}
