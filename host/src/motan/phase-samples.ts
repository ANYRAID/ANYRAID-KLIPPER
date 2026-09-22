// GPL-3.0-or-later. From readlog.py, copyright (C) 2021 Kevin O'Connor.
import {decodeStepBlock,type StepBlock,type DecodedSteps} from './motion-samples.ts';
import {motanObject,type StatusSnapshot} from './dispatch.ts';
export interface MotanPhaseConfig {driverName:string;stepperName:string;phases:number;}
const exact=(value:unknown):bigint=>{if(typeof value==='bigint')return value;if(typeof value==='number'&&Number.isSafeInteger(value))return BigInt(value);throw new Error('Motan phase requires exact integer positions and offsets');};
const own=(value:Record<string,unknown>,key:string)=>Object.hasOwn(value,key)?value[key]:undefined;
export function motanPhaseConfig(settings:Record<string,unknown>,driverName:string,selection:'phase'|'microstep'='phase'):MotanPhaseConfig{
 if(typeof driverName!=='string'||driverName.length>1024||!['phase','microstep'].includes(selection))throw new Error('Invalid Motan phase driver');const parts=driverName.split(/[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u).filter(Boolean),stepperName=parts.slice(1).join(' ');if(!stepperName||!Object.hasOwn(settings,driverName)||!Object.hasOwn(settings,stepperName))throw new Error('Missing Motan phase driver or stepper configuration');motanObject(settings[driverName]);const microsteps=own(motanObject(settings[stepperName]),'microsteps');if(typeof microsteps!=='number'||!Number.isSafeInteger(microsteps)||microsteps<1)throw new Error('Invalid Motan phase microsteps');const phases=microsteps*(selection==='phase'?4:1);if(phases>2147483647)throw new Error('Motan phase count exceeds limit');return {driverName,stepperName,phases};
}
interface Point {time:number;base:bigint;delta:number;}
export class MotanPhaseSampler {
 readonly #config:MotanPhaseConfig;readonly #steps:(time:number)=>Promise<StepBlock|null>;readonly #status:(time:number)=>Promise<StatusSnapshot>;readonly #limit:number;
 #previous:Point={time:0,base:0n,delta:0};#next:Point={time:0,base:0n,delta:0};#decoded:DecodedSteps|undefined;#at=0;#statusTime=0;#offset=0n;#last=-Infinity;#busy=false;#failure:Error|undefined;
 #cachedBase:bigint|undefined;#cachedOffset:bigint|undefined;#residue=0;
 constructor(config:MotanPhaseConfig,steps:(time:number)=>Promise<StepBlock|null>,status:(time:number)=>Promise<StatusSnapshot>,maxExpandedSteps=1000000){
  if(!config||typeof config.driverName!=='string'||!config.driverName.length||config.driverName.length>1024||typeof config.stepperName!=='string'||!config.stepperName.length||config.stepperName.length>1024||!Number.isSafeInteger(config.phases)||config.phases<1||config.phases>2147483647||!Number.isSafeInteger(maxExpandedSteps)||maxExpandedSteps<1||maxExpandedSteps>2000000)throw new Error('Invalid Motan phase sampler configuration');this.#config={...config};this.#steps=steps;this.#status=status;this.#limit=maxExpandedSteps;
 }
 async #advance(time:number,budget:{reads:number}):Promise<void>{
  this.#previous=this.#next;for(;;){if(this.#decoded&&this.#at<this.#decoded.times.length){const i=this.#at++;this.#next={time:this.#decoded.times[i],base:this.#decoded.startMcuPosition,delta:this.#decoded.mcuDeltas[i]};return;}
   if(++budget.reads>4096)throw new Error('Motan phase source block limit exceeded');const block=await this.#steps(time);if(block===null){const next=time+.1;if(!(next>time))throw new Error('Motan time cannot represent EOF lookahead');this.#next={...this.#previous,time:next};return;}
   if(typeof block.last_step_time!=='number'||!Number.isFinite(block.last_step_time))throw new Error('Invalid Motan phase block time');if(time>block.last_step_time)continue;
   // Phase depends on MCU counts only; commanded millimetre positions are not used.
   this.#decoded=decodeStepBlock({...block,step_distance:0,start_position:0},this.#limit);this.#at=0;if(this.#previous.time===0)this.#previous={time:0,base:this.#decoded.startMcuPosition,delta:0};
  }
 }
 async sample(time:number):Promise<number>{
  if(this.#failure)throw this.#failure;if(!Number.isFinite(time)||time<this.#last||this.#busy)throw new Error('Motan phase samples require sequential nondecreasing times');this.#last=time;this.#busy=true;
  try{if(time>=this.#statusTime){const snapshot=await this.#status(time);if(!Number.isFinite(snapshot.nextTime))throw new Error('Invalid Motan phase status time');const value=own(motanObject(snapshot.status),this.#config.driverName),driver=motanObject(value===undefined?{}:value);this.#offset=exact(own(driver,'mcu_phase_offset')??0);this.#statusTime=snapshot.nextTime;}
   const budget={reads:0};while(time>=this.#next.time)await this.#advance(time,budget);const {base,delta}=this.#previous,p=this.#config.phases;if(base!==this.#cachedBase||this.#offset!==this.#cachedOffset){const modulus=BigInt(p);this.#residue=Number(((base+this.#offset)%modulus+modulus)%modulus);this.#cachedBase=base;this.#cachedOffset=this.#offset;}return ((this.#residue+delta)%p+p)%p;
  }catch(error){this.#failure=error instanceof Error?error:new Error(String(error));throw this.#failure;}finally{this.#busy=false;}
 }
}
