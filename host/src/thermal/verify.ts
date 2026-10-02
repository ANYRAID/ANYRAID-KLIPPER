// Port of klippy/extras/verify_heater.py; GPL-3.0-or-later.
// Copyright (C) 2018 Kevin O'Connor.
export interface HeaterCheckConfig {hysteresis?:number;maxError?:number;heatingGain?:number;checkGainTime?:number;bed?:boolean;}
export interface HeaterCheckState {
 approaching:boolean;starting:boolean;lastTarget:number;goalTemperature:number;
 error:number;goalTime:number;faulted:boolean;
}
/** Invoke on the host's one-second verification timer, independently of sensor callbacks. */
export class HeaterCheck {
 #hysteresis:number;#maxError:number;#gain:number;#gainTime:number;#lastTime=-Infinity;
 #state:HeaterCheckState={approaching:false,starting:false,lastTarget:0,goalTemperature:0,error:0,goalTime:Infinity,faulted:false};
 constructor(config:HeaterCheckConfig={}) {
  this.#hysteresis=config.hysteresis??5;this.#maxError=config.maxError??120;this.#gain=config.heatingGain??2;this.#gainTime=config.checkGainTime??(config.bed?60:20);
  if(![this.#hysteresis,this.#maxError,this.#gain,this.#gainTime].every(Number.isFinite)||this.#hysteresis<0||this.#maxError<0||this.#gain<=0||this.#gainTime<1)throw new RangeError('Invalid heater verification configuration');
 }
 get state():HeaterCheckState{return {...this.#state};}
 /** Infinity means latched failure: caller must stop heating and cancel the timer. */
 check(time:number,temperature:number,target:number):number {
  if(this.#state.faulted)return Infinity;
  if(![time,temperature,target].every(Number.isFinite)||time<0||time<=this.#lastTime||temperature< -273.15||target<0)throw new RangeError('Invalid heater verification sample');
  const s={...this.#state};
  if(temperature>=target-this.#hysteresis||target<=0) {
   s.approaching=s.starting=false;if(temperature<=target+this.#hysteresis)s.error=0;s.lastTarget=target;
  } else {
   s.error+=(target-this.#hysteresis)-temperature;
   if(!s.approaching) {
    if(target!==s.lastTarget){s.approaching=s.starting=true;s.goalTemperature=temperature+this.#gain;s.goalTime=time+this.#gainTime;}
    else if(s.error>=this.#maxError)s.faulted=true;
   }else if(temperature>=s.goalTemperature) {
    s.starting=false;s.error=0;s.goalTemperature=temperature+this.#gain;s.goalTime=time+this.#gainTime;
   }else if(time>=s.goalTime)s.approaching=false;
   else if(s.starting)s.goalTemperature=Math.min(s.goalTemperature,temperature+this.#gain);
   // Upstream returns immediately on fault, preserving lastTarget.
   if(!s.faulted)s.lastTarget=target;
  }
  if(!Number.isFinite(s.error)||!Number.isFinite(s.goalTemperature))throw new RangeError('Heater verification overflow');
  this.#state=s;this.#lastTime=time;return s.faulted?Infinity:time+1;
 }
}
