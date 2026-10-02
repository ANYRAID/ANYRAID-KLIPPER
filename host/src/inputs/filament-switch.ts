import type {ConfigurationReader} from '../moonraker/config-reader.ts';
export interface FilamentPolicy {debounce:number;eventDelay:number;pause:boolean;}
export function readFilamentPolicy(reader:ConfigurationReader,section:string):Readonly<FilamentPolicy>{
 if(!/^filament_(switch|motion)_sensor \S/.test(section))throw new Error('Invalid filament sensor section');
 const c=reader.section(section);
 for(const key of ['runout_gcode','insert_gcode'])if(c.get(key,{defaultValue:''}).trim())throw new Error('Filament macros require typed operations');
 // Legacy delay only separated PAUSE from a subsequent macro. Typed pause is
 // awaited directly; it must never delay the initial request to stop feeding.
 c.getFloat('pause_delay',{defaultValue:.5,above:0});
 return Object.freeze({debounce:c.getFloat('debounce_delay',{defaultValue:0,minval:0,maxval:60}),eventDelay:c.getFloat('event_delay',{defaultValue:3,minval:0,maxval:3600}),pause:c.getBoolean('pause_on_runout',{defaultValue:true})});
}
export interface FilamentClock {now():number;schedule(callback:()=>void,seconds:number):()=>void;}
export interface FilamentSource {readonly status:{present:boolean;received:boolean;time:number|undefined};subscribe(callback:(time:number,present:boolean)=>void):()=>void;}
/** One bounded debounce timer, no automatic resume and no executable macros.
 * Recheck on entry to printing so an absent switch cannot be bypassed by resume.
 * Closing fences accepted pause completion without waiting on hardware teardown. */
export class FilamentSwitch {
 #present=false;#received=false;#raw=false;#last=-Infinity;#closed=false;#pending=false;#ready:number;#next=0;#cancel:(()=>void)|undefined;#detach:()=>void;
 private policy:Readonly<FilamentPolicy>;private clock:FilamentClock;private printing:()=>boolean;private pause:()=>Promise<void>;private fault:(error:unknown)=>void;
 constructor(source:FilamentSource,policy:Readonly<FilamentPolicy>,clock:FilamentClock,printing:()=>boolean,pause:()=>Promise<void>,fault:(error:unknown)=>void){
  this.policy=policy;this.clock=clock;this.printing=printing;this.pause=pause;this.fault=fault;
  this.#ready=clock.now()+2;
  this.#detach=source.subscribe((time,present)=>this.#input(time,present));
  const initial=source.status;if(initial.received)this.#input(initial.time!,initial.present);
 }
 get status(){return {filament_detected:this.#present,enabled:!this.#closed,pause_on_runout:this.policy.pause,valid:this.#received,closed:this.#closed};}
 get canResume():boolean{return !this.policy.pause||(!this.#closed&&this.#received&&this.#present&&this.#raw);}
 #input(time:number,present:boolean):void{
  if(this.#closed)return;
  if(!Number.isFinite(time)||time<0||time<this.#last){this.close();this.fault(new Error('Invalid filament input clock'));return;}
  const duplicate=this.#last!==-Infinity&&this.#raw===present;this.#last=time;if(duplicate)return;this.#raw=present;this.#cancel?.();
  this.#schedule(Math.max(this.#ready,time+this.policy.debounce),()=>{this.#present=this.#raw;this.#received=true;this.stateChanged();});
 }
 #schedule(at:number,action:()=>void):void{this.#cancel=this.clock.schedule(()=>{this.#cancel=undefined;if(!this.#closed)action();},Math.max(0,at-this.clock.now()));}
 stateChanged():void{
  if(this.#closed||!this.#received||this.#present||this.#pending||!this.policy.pause||!this.printing())return;
  const now=this.clock.now();if(now<this.#next){if(!this.#cancel)this.#schedule(this.#next,()=>this.stateChanged());return;}
  this.#pending=true;
  void Promise.resolve().then(()=>{if(!this.#closed&&this.printing())return this.pause();}).then(()=>{this.#pending=false;this.#next=this.clock.now()+this.policy.eventDelay;},error=>{this.#pending=false;if(!this.#closed){this.close();this.fault(error);}});
 }
 close():void{if(this.#closed)return;this.#closed=true;this.#cancel?.();this.#cancel=undefined;this.#detach();}
}
