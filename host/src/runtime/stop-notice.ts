import {isPromise} from 'node:util/types';
/** One-shot invalidation, separate from physical stop acknowledgement. Observer
 * work is never awaited, including reentrant calls to the same stop operation. */
export class StopNotice {
 #listeners=new Set<(cause:unknown)=>void>();#fired=false;#cause:unknown;#errors:unknown[]=[];
 get errors():readonly unknown[]{return [...this.#errors];}
 #error(error:unknown){if(this.#errors.length<64)this.#errors.push(error);}
 #notify(listener:(cause:unknown)=>void){try{const pending:unknown=listener(this.#cause);if(isPromise(pending))void pending.catch(error=>this.#error(error));}catch(error){this.#error(error);}}
 subscribe(listener:(cause:unknown)=>void):()=>void{
  if(typeof listener!=='function'||this.#listeners.has(listener)||this.#listeners.size>=64)throw new Error('Invalid stop subscription');
  if(this.#fired){this.#notify(listener);return ()=>{};}
  this.#listeners.add(listener);return ()=>{this.#listeners.delete(listener);};
 }
 emit(cause:unknown):void{if(this.#fired)return;this.#fired=true;this.#cause=cause;const listeners=[...this.#listeners];this.#listeners.clear();for(const listener of listeners)this.#notify(listener);}
}
