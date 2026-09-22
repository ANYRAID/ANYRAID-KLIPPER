import type {PrintState} from './print.ts';
export interface PrintStateChange {readonly state:PrintState;readonly stateToken:string;}
/** One unread state per observer. Resolving next never calls consumer code in
 * the printer transition stack. This is a live view, not an audit/event log. */
export class PrintStateStream implements AsyncIterableIterator<PrintStateChange> {
 #latest:PrintStateChange|undefined;#pending:ReturnType<typeof Promise.withResolvers<IteratorResult<PrintStateChange>>>|undefined;
 #closed=false;#signal:AbortSignal;#release:()=>void;#abort=()=>{this.#close();};
 constructor(initial:PrintStateChange,signal:AbortSignal,release:()=>void){
  signal.throwIfAborted();this.#latest=initial;this.#signal=signal;this.#release=release;signal.addEventListener('abort',this.#abort,{once:true});
 }
 [Symbol.asyncIterator](){return this;}
 next():Promise<IteratorResult<PrintStateChange>>{
  if(this.#closed)return Promise.resolve({done:true,value:undefined});
  if(this.#pending)return Promise.reject(new Error('Print state read already pending'));
  if(this.#latest){const value=this.#latest;this.#latest=undefined;return Promise.resolve({done:false,value});}
  this.#pending=Promise.withResolvers<IteratorResult<PrintStateChange>>();return this.#pending.promise;
 }
 publish(value:PrintStateChange):void{
  if(this.#closed)return;
  if(this.#pending){const pending=this.#pending;this.#pending=undefined;pending.resolve({done:false,value});}else this.#latest=value;
 }
 #close():void{if(this.#closed)return;this.#closed=true;this.#latest=undefined;this.#signal.removeEventListener('abort',this.#abort);this.#release();this.#pending?.resolve({done:true,value:undefined});this.#pending=undefined;}
 return():Promise<IteratorResult<PrintStateChange>>{this.#close();return Promise.resolve({done:true,value:undefined});}
}
