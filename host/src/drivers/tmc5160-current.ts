// TMC5160 current conversion from klippy/extras/tmc5160.py. GPL-3.0-or-later.
import type {TmcSpiDevice} from './tmc-spi.ts';
export function tmc5160Current(run:number,hold=10,resistor=.075){
 if(!Number.isFinite(run)||run<0||run>10||!Number.isFinite(hold)||hold<=0||hold>10||!Number.isFinite(resistor)||resistor<=0)throw new RangeError('Invalid TMC5160 current');
 const scaled=run*256*Math.SQRT2*resistor/.325+.5;if(!Number.isFinite(scaled))throw new RangeError('TMC5160 current arithmetic overflow');
 let globalscaler=Math.max(32,Math.trunc(scaled));if(globalscaler>=256)globalscaler=0;
 const scale=globalscaler||256,bits=(amps:number)=>{const value=amps*256*32*Math.SQRT2*resistor/(scale*.325)-1+.5;if(!Number.isFinite(value))throw new RangeError('TMC5160 current arithmetic overflow');return Math.max(0,Math.min(31,Math.trunc(value)));};
 const irun=bits(run),ihold=bits(Math.min(hold,run)),amps=(cs:number)=>scale*(cs+1)*.325/(256*32*Math.SQRT2*resistor);
 const runCurrent=amps(irun),holdCurrent=amps(ihold);if(!Number.isFinite(runCurrent)||!Number.isFinite(holdCurrent))throw new RangeError('TMC5160 current arithmetic overflow');
 return Object.freeze({globalscaler,irun,ihold,runCurrent,holdCurrent});
}
/** Caller owns the complete motion barrier. Both registers are acknowledged
 * before publishing; ambiguous partial updates retire the hardware owner. */
export class Tmc5160Current {
 #device:Pick<TmcSpiDevice,'write'>;#current:ReturnType<typeof tmc5160Current>;#hold:number;#resistor:number;#ihold:number;#lifetime:AbortSignal;#fault:(cause:unknown)=>void;#busy=false;#failed=false;#revision=0;
 constructor(device:Pick<TmcSpiDevice,'write'>,plan:{current:ReturnType<typeof tmc5160Current>;requestedHold:number;resistor:number;registers:readonly {name:string;value:number}[]},lifetime:AbortSignal,fault:(cause:unknown)=>void){this.#device=device;this.#current=plan.current;this.#hold=plan.requestedHold;this.#resistor=plan.resistor;this.#ihold=plan.registers.find(r=>r.name==='IHOLD_IRUN')!.value;this.#lifetime=lifetime;this.#fault=fault;}
 get current(){return this.#current;}
 get revision(){return this.#revision;}
 async set(change:{run?:number;hold?:number},signal:AbortSignal){
  const combined=AbortSignal.any([signal,this.#lifetime]);combined.throwIfAborted();if(this.#failed||this.#busy)throw new Error('TMC5160 current owner unavailable');
  const hold=change.hold??this.#hold,next=tmc5160Current(change.run??this.#current.runCurrent,hold,this.#resistor);if(change.run===undefined&&change.hold===undefined)return;
  const ihold=((this.#ihold&~0x1f1f)|(next.irun<<8)|next.ihold)>>>0;this.#busy=true;
  try{await this.#device.write(0x0b,next.globalscaler,combined);combined.throwIfAborted();await this.#device.write(0x10,ihold,combined);combined.throwIfAborted();this.#current=next;this.#hold=hold;this.#ihold=ihold;this.#revision++;}
  catch(error){this.#failed=true;this.#fault(error);throw error;}finally{this.#busy=false;}
 }
}
