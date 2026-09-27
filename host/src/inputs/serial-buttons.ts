import {ButtonInput,buttonFormats,type CompiledButtons,type ButtonBatch} from './buttons.ts';
import type {SerialSession,TimedCommandQueue} from '../protocol/serial-session.ts';
import type {TimedResponse} from '../protocol/clock-transport.ts';
/** Subscribe before configuring the MCU; activate after its output queues exist.
 * ACK publication is serialized, bounded, and precedes consumer notification.
 * Consumer callbacks must enqueue typed actions without waiting for them. */
export class SerialButtonsInput {
 #input:ButtonInput;#session:SerialSession;#plan:CompiledButtons;#publish:(time:number,batch:ButtonBatch)=>void;#fault:(error:unknown)=>void;
 #detach:()=>void=()=>{};#abort=new AbortController();#queue:TimedCommandQueue|undefined;#pending:{time:number;batch:ButtonBatch}[]=[];#running:Promise<void>|undefined;#last=-Infinity;#error:unknown;
 constructor(session:SerialSession,plan:CompiledButtons,publish:(time:number,batch:ButtonBatch)=>void,fault:(error:unknown)=>void){
  this.#session=session;this.#plan=plan;this.#input=new ButtonInput(plan);this.#publish=publish;this.#fault=fault;
  this.#detach=session.subscribeResponse(buttonFormats.state,plan.oid,{receive:r=>this.#receive(r),closed:cause=>{if(this.#abort.signal.aborted)return;this.#fence(cause);queueMicrotask(()=>this.#fault(cause));}});
 }
 get status(){return {active:!!this.#queue&&!this.#abort.signal.aborted,closed:this.#abort.signal.aborted,pending:this.#pending.length+(this.#running?1:0),fault:this.#error,input:this.#input.status};}
 activate(queue:TimedCommandQueue):void{if(this.#queue||this.#abort.signal.aborted)throw new Error('Buttons input cannot activate');this.#session.assertActive();this.#session.configuration;this.#queue=queue;this.#drain();}
 #fence(cause:unknown):void{if(this.#abort.signal.aborted)return;this.#error=cause;this.#abort.abort(cause);this.#detach();this.#pending=[];}
 #fail(cause:unknown):void{if(this.#abort.signal.aborted)return;this.#fence(cause);this.#fault(cause);}
 #receive(response:TimedResponse):void{
  if(this.#abort.signal.aborted)return;
  try{
   if(!Number.isFinite(response.receiveTime)||response.receiveTime<0||response.receiveTime<this.#last)throw new Error('Invalid buttons receive time');
   const batch=this.#input.receive(response.message);if(!batch)return;
   if(this.#pending.length+(this.#running?1:0)>=32)throw new Error('Buttons delivery queue exhausted');
   this.#last=response.receiveTime;this.#pending.push({time:response.receiveTime,batch});this.#drain();
  }catch(error){this.#fail(error);}
 }
 #drain():void{
  if(!this.#queue||this.#running||this.#abort.signal.aborted||!this.#pending.length)return;
  const work=(async()=>{while(this.#pending.length){const item=this.#pending.shift()!,signal=this.#abort.signal;signal.throwIfAborted();await this.#queue!.send(this.#session.dictionary.encode('buttons_ack',{oid:this.#plan.oid,count:item.batch.ack}),0n,0n,signal);signal.throwIfAborted();this.#publish(item.time,item.batch);}})();
  this.#running=work;void work.then(()=>{this.#running=undefined;this.#drain();},error=>{this.#running=undefined;this.#fail(error);});
 }
 async close(cause:unknown=new Error('Buttons input closed')):Promise<void>{this.#fence(cause);await this.#running?.catch(()=>{});}
}
