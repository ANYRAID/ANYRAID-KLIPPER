// TMC2240 current conversion from klippy/extras/tmc2240.py. GPL-3.0-or-later.
const kifs=[11750,24000,36000,36000] as const;
export function tmc2240FullScale(rref=12000,currentRange=3){
 if(!Number.isFinite(rref)||rref<12000||rref>60000||!Number.isInteger(currentRange)||currentRange<0||currentRange>3)throw new RangeError('Invalid TMC2240 current range');
 return (kifs[currentRange]/rref)/Math.SQRT2;
}
/** Range is chosen only at startup. Live changes preserve DRV_CONF.current_range. */
export function tmc2240Current(run:number,hold:number|undefined=undefined,rref=12000,currentRange?:number){
 const maximum=tmc2240FullScale(rref);hold??=maximum;
 if(!Number.isFinite(run)||run<0||run>maximum||!Number.isFinite(hold)||hold<=0||hold>maximum)throw new RangeError('Invalid TMC2240 current');
 if(currentRange===undefined){currentRange=0;while(currentRange<3&&run>tmc2240FullScale(rref,currentRange))currentRange++;}
 const fullScale=tmc2240FullScale(rref,currentRange);if(run>fullScale)throw new RangeError('Current exceeds initialized TMC2240 range');
 let globalscaler=Math.max(32,Math.trunc(run*256/fullScale+.5));if(globalscaler>=256)globalscaler=0;
 const scale=globalscaler||256,bits=(amps:number)=>Math.max(0,Math.min(31,Math.trunc((amps*256*32)/(scale*fullScale)-1+.5)));
 const irun=bits(run),ihold=bits(Math.min(hold,run)),amps=(cs:number)=>scale*(cs+1)*fullScale/(256*32);
 return Object.freeze({currentRange,globalscaler,irun,ihold,runCurrent:amps(irun),holdCurrent:amps(ihold),fullScale});
}
/** Both SPI and UART adapters supply acknowledged writes. The caller owns the
 * motion barrier; a partial update retires hardware before publishing state. */
export class Tmc2240Current {
 #device:{write(register:number,value:number,signal:AbortSignal):Promise<void>};#current:ReturnType<typeof tmc2240Current>;#hold:number;#rref:number;#ihold:number;#lifetime:AbortSignal;#fault:(cause:unknown)=>void;#busy=false;#failed=false;#revision=0;
 constructor(device:{write(register:number,value:number,signal:AbortSignal):Promise<void>},plan:{current:ReturnType<typeof tmc2240Current>;requestedHold:number;rref:number;registers:readonly {name:string;value:number}[]},lifetime:AbortSignal,fault:(cause:unknown)=>void){
  const ihold=plan.registers.find(r=>r.name==='IHOLD_IRUN');if(!ihold||!Number.isInteger(ihold.value)||ihold.value<0||ihold.value>0xffffffff)throw new Error('Missing TMC2240 current register');
  this.#device=device;this.#current=plan.current;this.#hold=plan.requestedHold;this.#rref=plan.rref;this.#ihold=ihold.value;this.#lifetime=lifetime;this.#fault=fault;
 }
 get maxCurrent(){return this.#current.fullScale;}
 get current(){return this.#current;}
 get revision(){return this.#revision;}
 async set(change:{run?:number;hold?:number},signal:AbortSignal){
  const combined=AbortSignal.any([signal,this.#lifetime]);combined.throwIfAborted();if(this.#failed||this.#busy)throw new Error('TMC2240 current owner unavailable');
  if(change.hold!==undefined&&change.hold>this.maxCurrent)throw new RangeError('Hold current exceeds initialized TMC2240 range');
  const hold=change.hold??this.#hold,next=tmc2240Current(change.run??this.#current.runCurrent,hold,this.#rref,this.#current.currentRange);if(change.run===undefined&&change.hold===undefined)return;
  const ihold=((this.#ihold&~0x1f1f)|(next.irun<<8)|next.ihold)>>>0;this.#busy=true;
  try{await this.#device.write(0x0b,next.globalscaler,combined);combined.throwIfAborted();await this.#device.write(0x10,ihold,combined);combined.throwIfAborted();this.#current=next;this.#hold=hold;this.#ihold=ihold;this.#revision++;}
  catch(error){this.#failed=true;this.#fault(error);throw error;}finally{this.#busy=false;}
 }
}
