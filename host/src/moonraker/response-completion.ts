import {ApiError} from './rpc.ts';
/** Frame-level handoff barrier. Callbacks must be synchronous and bounded;
 * sent means accepted by the transport, never acknowledged by the remote app. */
export class ResponseCompletion {
 #callbacks:((sent:boolean)=>void)[]=[];#signal:AbortSignal;#done=false;#error:AggregateError|undefined;#abort:()=>void;
 constructor(signal:AbortSignal){this.#signal=signal;this.#abort=()=>{this.complete(false);};signal.addEventListener('abort',this.#abort,{once:true});if(signal.aborted)this.complete(false);}
 get error(){return this.#error;}
 add(callback:(sent:boolean)=>void):void{if(this.#done)throw new ApiError(503,'Response already completed');if(typeof callback!=='function')throw new TypeError('Response callback must be a function');if(this.#callbacks.length>=256)throw new ApiError(429,'Response callback capacity exceeded');this.#callbacks.push(callback);}
 complete(sent:boolean):boolean{if(this.#done)return !this.#error;this.#done=true;this.#signal.removeEventListener('abort',this.#abort);const callbacks=this.#callbacks;this.#callbacks=[];const errors:unknown[]=[];for(const callback of callbacks)try{callback(sent&&!this.#signal.aborted);}catch(error){errors.push(error);}if(errors.length)this.#error=new AggregateError(errors,'Response completion callback failed');return !this.#error;}
}
