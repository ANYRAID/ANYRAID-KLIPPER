import {SerialButtonsInput} from './serial-buttons.ts';
import type {CompiledButtons} from './buttons.ts';
import type {SerialSession,TimedCommandQueue} from '../protocol/serial-session.ts';
/** Single switch snapshot and subscription. No consumer actions during replay:
 * callers read status explicitly when installing a policy. */
export class SwitchInput {
 #listeners=new Set<(time:number,present:boolean)=>void>();#present=false;#time:number|undefined;#closed=false;
 #serial:SerialButtonsInput;
 constructor(session:SerialSession,plan:CompiledButtons,fault:(error:unknown)=>void){
  if(plan.count!==1)throw new Error('Switch input requires one button');
  this.#serial=new SerialButtonsInput(session,plan,(time,batch)=>{for(const sample of batch.samples){this.#present=!!sample.state;this.#time=time;for(const listener of this.#listeners){if(this.#closed)break;listener(time,this.#present);}}},fault);
 }
 get status(){return {present:this.#present,received:this.#time!==undefined,time:this.#time,closed:this.#closed||this.#serial.status.closed};}
 subscribe(listener:(time:number,present:boolean)=>void):()=>void{if(this.status.closed||typeof listener!=='function'||this.#listeners.size>=32)throw new Error('Invalid switch subscription');this.#listeners.add(listener);return ()=>{this.#listeners.delete(listener);};}
 activate(queue:TimedCommandQueue):void{this.#serial.activate(queue);}
 async close(cause?:unknown):Promise<void>{this.#closed=true;this.#listeners.clear();await this.#serial.close(cause);}
}
