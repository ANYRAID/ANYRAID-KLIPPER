import {FilamentMotionState} from './filament-motion.ts';
import {FilamentSwitch,readFilamentPolicy,type FilamentClock,type FilamentSource,type FilamentPolicy} from './filament-switch.ts';
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
export function readFilamentEncoderPolicy(reader:ConfigurationReader,section:string){
 const config=reader.section(section);if(!section.startsWith('filament_motion_sensor '))throw new Error('Invalid encoder section');
 const extruder=config.get('extruder');if(extruder!=='extruder')throw new Error('Encoder requires the configured single extruder');
 return Object.freeze({...readFilamentPolicy(reader,section),debounce:0,detectionLength:config.getFloat('detection_length',{defaultValue:7,above:0}),extruder});
}
export interface EncoderObservation {position:number;generation:object;}
/** Encoder edges reset distance; 250 ms polls check observed pulse history.
 * A replacement generation never clears a latched runout without an edge.
 * Unknown history during printing fails the hardware owner rather than guessing. */
export class FilamentEncoder {
 #switch:FilamentSwitch;#state:FilamentMotionState;#generation:object|undefined;#raw:boolean|undefined;#closed=false;#timer:(()=>void)|undefined;#detach:()=>void;#publish:((time:number,present:boolean)=>void)|undefined;#present=false;#received=false;#latched=false;
 private clock:FilamentClock;private observe:(time:number)=>EncoderObservation|undefined;private printing:()=>boolean;private fault:(error:unknown)=>void;private length:number;
 constructor(source:FilamentSource,policy:FilamentPolicy&{detectionLength:number},clock:FilamentClock,observe:(time:number)=>EncoderObservation|undefined,printing:()=>boolean,pause:()=>Promise<void>,fault:(error:unknown)=>void){
  this.clock=clock;this.observe=observe;this.printing=printing;this.fault=fault;this.length=policy.detectionLength;this.#state=new FilamentMotionState(this.length);
  this.#switch=new FilamentSwitch({status:{received:false,present:false,time:undefined},subscribe:fn=>{this.#publish=fn;return ()=>{this.#publish=undefined;};}},{...policy,debounce:0},clock,printing,pause,error=>this.#fail(error));
  this.#detach=source.subscribe((time,present)=>{if(this.#raw===present)return;this.#raw=present;this.#sample(time,true);});
  const initial=source.status;if(initial.received){this.#raw=initial.present;this.#sample(initial.time!,true);}
  this.#tick();
 }
 get status(){return {...this.#switch.status,detection_length:this.length};}
 get canResume(){return this.#switch.canResume;}
 stateChanged():void{this.#switch.stateChanged();}
 #fail(error:unknown):void{if(this.#closed)return;this.close();this.fault(error);}
 #sample(time:number,edge:boolean):void{
  if(this.#closed)return;
  try{
   const observed=this.observe(time);if(!observed){if(this.printing())throw new Error('Encoder position history unavailable during printing');return;}
   const changed=this.#generation!==observed.generation,now=this.clock.now();
   // An ACKed edge may predate the last poll; its position uses event time,
   // while state publication uses processing time and stays monotonic.
   if(changed){this.#generation=observed.generation;this.#state=new FilamentMotionState(this.length);this.#state.pulse(now,observed.position);}
   if(edge){this.#state.pulse(now,observed.position);this.#latched=false;}
   let present=edge||(!this.#received||this.#present)&&changed?true:this.printing()?this.#state.check(now,observed.position):this.#present;
   if(this.#latched)present=false;if(!present)this.#latched=true;
   if(!this.#received||present!==this.#present){this.#present=present;this.#received=true;this.#publish?.(now,present);}
  }catch(error){this.#fail(error);}
 }
 #tick():void{if(this.#closed)return;this.#sample(this.clock.now(),false);if(!this.#closed)this.#timer=this.clock.schedule(()=>{this.#timer=undefined;this.#tick();},.25);}
 close():void{if(this.#closed)return;this.#closed=true;this.#timer?.();this.#timer=undefined;this.#detach?.();this.#switch.close();}
}
