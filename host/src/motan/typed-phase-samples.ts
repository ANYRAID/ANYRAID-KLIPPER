// GPL-3.0-or-later. From readlog.py, copyright (C) 2021 Kevin O'Connor.
import {decodeStepBlock,type StepBlock,type DecodedSteps} from './motion-samples.ts';
import {motanObject,type StatusSnapshot} from './dispatch.ts';
import {motanTypedValue} from './number-types.ts';
import {motanPhaseConfig} from './phase-samples.ts';
export interface MotanTypedPhaseConfig {driverName:string;stepperName:string;phases:number|bigint;}
const checked=(v:number):number=>{if(!Number.isFinite(v))throw new Error('Motan phase calculation exceeds finite range');return v;};
const scalar=(v:unknown):number|bigint=>{if(typeof v==='bigint')return v;if(typeof v==='boolean')return v?1n:0n;if(typeof v==='number')return checked(v);throw new Error('Motan phase requires numeric positions and offsets');};
export function motanTypedPhaseConfig(settings:Record<string,unknown>,driverName:string,selection:'phase'|'microstep'='phase'):MotanTypedPhaseConfig{
 const config=motanPhaseConfig(settings,driverName,selection),stepper=motanObject(settings[config.stepperName]);
 return {...config,phases:typeof motanTypedValue(stepper,'microsteps')==='bigint'?BigInt(config.phases):config.phases};
}
interface Point {time:number;base:number|bigint;delta:number;}
/** Explicit JSON types only. Keep the legacy integer-only sampler independent
 * so optional scalar support does not polymorphize its hot loop. */
export class MotanTypedPhaseSampler {
 readonly #config:MotanTypedPhaseConfig;readonly #steps:(time:number)=>Promise<StepBlock|null>;readonly #status:(time:number)=>Promise<StatusSnapshot>;readonly #limit:number;
 #previous:Point={time:0,base:0n,delta:0};#next:Point={time:0,base:0n,delta:0};#decoded:DecodedSteps|undefined;#floating:Float64Array|undefined;#at=0;#statusTime=0;#offset:number|bigint=0n;#last=-Infinity;#busy=false;#failure:Error|undefined;
 #cachedBase:bigint|undefined;#cachedOffset:bigint|undefined;#residue=0;
 constructor(config:MotanTypedPhaseConfig,steps:(time:number)=>Promise<StepBlock|null>,status:(time:number)=>Promise<StatusSnapshot>,maxExpandedSteps=1000000){
  if(!config||typeof config.driverName!=='string'||!config.driverName.length||config.driverName.length>1024||typeof config.stepperName!=='string'||!config.stepperName.length||config.stepperName.length>1024||!['number','bigint'].includes(typeof config.phases)||!Number.isSafeInteger(Number(config.phases))||Number(config.phases)<1||Number(config.phases)>2147483647||!Number.isSafeInteger(maxExpandedSteps)||maxExpandedSteps<1||maxExpandedSteps>2000000)throw new Error('Invalid Motan phase sampler configuration');
  this.#config={...config};this.#steps=steps;this.#status=status;this.#limit=maxExpandedSteps;
 }
 async #advance(time:number,budget:{reads:number}):Promise<void>{
  this.#previous=this.#next;
  for(;;){
   if(this.#decoded&&this.#at<this.#decoded.times.length){const i=this.#at++;this.#next={time:this.#decoded.times[i],base:this.#floating?this.#floating[i]:this.#decoded.startMcuPosition,delta:this.#floating?0:this.#decoded.mcuDeltas[i]};return;}
   if(++budget.reads>4096)throw new Error('Motan phase source block limit exceeded');const block=await this.#steps(time);
   if(block===null){const next=time+.1;if(!(next>time))throw new Error('Motan time cannot represent EOF lookahead');this.#next={...this.#previous,time:next};return;}
   if(typeof block.last_step_time!=='number'||!Number.isFinite(block.last_step_time))throw new Error('Invalid Motan phase block time');if(time>block.last_step_time)continue;
   const base=scalar(motanTypedValue(block as unknown as Record<string,unknown>,'start_mcu_position'));
   this.#decoded=decodeStepBlock({...block,start_mcu_position:typeof base==='bigint'?base:0n,step_distance:0,start_position:0},this.#limit);this.#floating=undefined;
   if(typeof base==='number'){
    // Reuse the otherwise unused millimetre positions buffer. Float += 1 must
    // round after every step; converting base + cumulative delta is different.
    this.#floating=this.#decoded.positions;let position=base,delta=0;
    for(let i=0;i<this.#floating.length;i++){const next=this.#decoded.mcuDeltas[i];position=checked(position+(next-delta));this.#floating[i]=position;delta=next;}
   }
   this.#at=0;if(this.#previous.time===0)this.#previous={time:0,base,delta:0};
  }
 }
 #value():number|bigint{
  const {base,delta}=this.#previous,offset=this.#offset,phases=this.#config.phases;
  if(typeof base==='bigint'&&typeof offset==='bigint'&&typeof phases==='bigint'){
   if(base!==this.#cachedBase||offset!==this.#cachedOffset){this.#residue=Number(((base+offset)%phases+phases)%phases);this.#cachedBase=base;this.#cachedOffset=offset;}
   const p=Number(phases);return BigInt(((this.#residue+delta)%p+p)%p);
  }
  const position=typeof base==='bigint'?base+BigInt(delta):base;
  const total=typeof position==='bigint'&&typeof offset==='bigint'?checked(Number(position+offset)):checked(checked(Number(position))+checked(Number(offset)));
  const p=Number(phases),remainder=total%p;
  // Python's positive-divisor float modulo adds p only for negative remainder.
  // A second modulo or unconditional +p loses small residuals and -0 handling.
  return remainder===0?0:remainder<0?remainder+p:remainder;
 }
 async sample(time:number):Promise<number|bigint>{
  if(this.#failure)throw this.#failure;if(!Number.isFinite(time)||time<this.#last||this.#busy)throw new Error('Motan phase samples require sequential nondecreasing times');this.#last=time;this.#busy=true;
  try{
   if(time>=this.#statusTime){const snapshot=await this.#status(time);if(!Number.isFinite(snapshot.nextTime))throw new Error('Invalid Motan phase status time');const status=motanObject(snapshot.status),value=Object.hasOwn(status,this.#config.driverName)?status[this.#config.driverName]:undefined,driver=motanObject(value===undefined?{}:value);this.#offset=Object.hasOwn(driver,'mcu_phase_offset')?scalar(motanTypedValue(driver,'mcu_phase_offset')??0n):0n;this.#statusTime=snapshot.nextTime;}
   const budget={reads:0};while(time>=this.#next.time)await this.#advance(time,budget);return this.#value();
  }catch(error){this.#failure=error instanceof Error?error:new Error(String(error));throw this.#failure;}finally{this.#busy=false;}
 }
}
