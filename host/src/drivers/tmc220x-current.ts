import {tmc220xCurrent,type planTmc220x} from './tmc220x.ts';
import type {TmcUartDevice} from './tmc-uart.ts';
/** Caller must drain motion and hold dispatch ownership for the entire update.
 * Publish only acknowledged register pairs. Any ambiguous write retires hardware. */
export class Tmc220xCurrent {
 #current:ReturnType<typeof tmc220xCurrent>;#hold:number;#resistor:number;#chop:number;#ihold:number;
 #device:Pick<TmcUartDevice,'write'>;#lifetime:AbortSignal;#fault:(cause:unknown)=>void;#busy=false;#failed=false;#revision=0;
 constructor(device:Pick<TmcUartDevice,'write'>,plan:Pick<ReturnType<typeof planTmc220x>,'current'|'requestedHold'|'resistor'> & {registers:readonly {name:string;value:number}[]},lifetime:AbortSignal,fault:(cause:unknown)=>void){
  this.#device=device;this.#current=plan.current;this.#hold=plan.requestedHold;this.#resistor=plan.resistor;
  this.#chop=plan.registers.find(r=>r.name==='CHOPCONF')!.value;this.#ihold=plan.registers.find(r=>r.name==='IHOLD_IRUN')!.value;this.#lifetime=lifetime;this.#fault=fault;
 }
 get revision(){return this.#revision;}
 get current(){return this.#current;}
 async set(change:{run?:number;hold?:number},signal:AbortSignal):Promise<void>{
  const combined=AbortSignal.any([signal,this.#lifetime]);combined.throwIfAborted();
  if(this.#failed||this.#busy)throw new Error('TMC current owner unavailable');
  const hold=change.hold??this.#hold,next=tmc220xCurrent(change.run??this.#current.runCurrent,hold,this.#resistor);
  if(change.run===undefined&&change.hold===undefined)return;
  const chop=((this.#chop&~(1<<17))|(Number(next.vsense)<<17))>>>0,ihold=((this.#ihold&~0x1f1f)|(next.irun<<8)|next.ihold)>>>0;
  this.#busy=true;
  try{
   if(chop!==this.#chop)await this.#device.write(0x6c,chop,combined);
   combined.throwIfAborted();await this.#device.write(0x10,ihold,combined);combined.throwIfAborted();
   this.#current=next;this.#hold=hold;this.#chop=chop;this.#ihold=ihold;this.#revision++;
  }catch(error){this.#failed=true;this.#fault(error);throw error;}finally{this.#busy=false;}
 }
}
