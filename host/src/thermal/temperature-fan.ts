// Cooling control from klippy/extras/temperature_fan.py; GPL-3.0-or-later.
// Copyright (C) 2016-2020 Kevin O'Connor.
export interface TemperatureFanSettings {minimumTemperature:number;maximumTemperature:number;target:number;minimumSpeed:number;maximumSpeed:number;}
export type TemperatureFanAlgorithm={kind:'watermark';delta:number}|{kind:'pid';kp:number;ki:number;kd:number;derivativeTime:number};
function validate(s:TemperatureFanSettings):void{
 if(!Object.values(s).every(Number.isFinite)||s.minimumTemperature< -273.15||s.maximumTemperature<=s.minimumTemperature||s.target!==0&&(s.target<s.minimumTemperature||s.target>s.maximumTemperature)||s.minimumSpeed<0||s.maximumSpeed>1||s.maximumSpeed<0||s.minimumSpeed>s.maximumSpeed)throw new RangeError('Invalid temperature fan settings');
}
/** Sample-clock control only. Runtime must own sensor freshness, output MCU
 * scheduling and shutdown cooling; this class does not authorize PWM itself. */
export class TemperatureFanControl {
 #settings:TemperatureFanSettings;#algorithm:TemperatureFanAlgorithm;#delay:number;#time=0;#temperature=25;#derivative=0;#integral=0;#integralMax=0;#heating=false;#next=0;#speed=0;
 constructor(settings:TemperatureFanSettings,algorithm:TemperatureFanAlgorithm,reportDelay:number){
  validate(settings);if(!Number.isFinite(reportDelay)||reportDelay<=0)throw new RangeError('Invalid temperature fan report delay');
  if(algorithm.kind==='watermark'){if(!Number.isFinite(algorithm.delta)||algorithm.delta<=0||!Number.isFinite(settings.target+algorithm.delta))throw new RangeError('Invalid fan hysteresis');}
  else if(algorithm.kind==='pid'){if(![algorithm.kp,algorithm.ki,algorithm.kd].every(v=>Number.isFinite(v)&&v>=0)||!Number.isFinite(algorithm.derivativeTime)||algorithm.derivativeTime<=0)throw new RangeError('Invalid fan PID');this.#integralMax=algorithm.ki?settings.maximumSpeed/(algorithm.ki/255):0;if(!Number.isFinite(this.#integralMax))throw new RangeError('Fan integral limit overflow');}
  else throw new RangeError('Unknown temperature fan algorithm');
  this.#settings={...settings};this.#algorithm={...algorithm};this.#delay=reportDelay;
 }
 get reportDelay(){return this.#delay;}
 get settings(){return Object.freeze({...this.#settings});}
 get state(){return {time:this.#time,temperature:this.#temperature,derivative:this.#derivative,integral:this.#integral,heating:this.#heating,scheduledSpeed:this.#speed};}
 /** Validate the entire request before changing any field. */
 configure(update:Partial<Pick<TemperatureFanSettings,'target'|'minimumSpeed'|'maximumSpeed'>>):void{
  if(Object.keys(update).some(k=>!['target','minimumSpeed','maximumSpeed'].includes(k)))throw new RangeError('Unknown temperature fan setting');
  const next={...this.#settings,...update};validate(next);if(this.#algorithm.kind==='watermark'&&!Number.isFinite(next.target+this.#algorithm.delta))throw new RangeError('Fan hysteresis overflow');this.#settings=next;
 }
 sample(time:number,temperature:number):{time:number;speed:number}|undefined{
  const s=this.#settings,a=this.#algorithm;
  if(!Number.isFinite(time)||time<=this.#time||!Number.isFinite(temperature)||temperature<s.minimumTemperature||temperature>s.maximumTemperature)throw new RangeError('Invalid temperature fan sample');
  let requested:number,derivative=this.#derivative,integral=this.#integral,heating=this.#heating;
  if(a.kind==='watermark'){
   if(heating&&temperature>=s.target+a.delta)heating=false;else if(!heating&&temperature<=s.target-a.delta)heating=true;
   requested=heating?0:s.maximumSpeed;
  }else{
   const dt=time-this.#time,diff=temperature-this.#temperature,kp=a.kp/255,ki=a.ki/255,kd=a.kd/255;
   derivative=dt>=a.derivativeTime?diff/dt:(this.#derivative*(a.derivativeTime-dt)+diff)/a.derivativeTime;
   const error=s.target-temperature,nextIntegral=Math.max(0,Math.min(this.#integralMax,this.#integral+error*dt)),output=kp*error+ki*nextIntegral-kd*derivative,bounded=Math.max(0,Math.min(s.maximumSpeed,output));
   if(![derivative,nextIntegral,output].every(Number.isFinite))throw new RangeError('Temperature fan PID overflow');
   requested=Math.max(s.minimumSpeed,s.maximumSpeed-bounded);if(output===bounded)integral=nextIntegral;
  }
  const speed=s.target<=0||requested<=0?0:Math.max(s.minimumSpeed,requested),scheduled=time+this.#delay,next=scheduled+3.75;
  if(!Number.isFinite(scheduled)||scheduled<=time||!Number.isFinite(next)||next<=scheduled)throw new RangeError('Temperature fan schedule precision exhausted');
  this.#time=time;this.#temperature=temperature;this.#derivative=derivative;this.#integral=integral;this.#heating=heating;
  // Preserve the original refresh cadence, but never suppress a real off edge
  // or a newly tightened speed ceiling, even below the 0.05 change threshold.
  if(!(speed===0&&this.#speed!==0)&&this.#speed<=s.maximumSpeed&&(time<this.#next||!this.#speed)&&Math.abs(speed-this.#speed)<.05)return;
  this.#next=next;this.#speed=speed;return {time:scheduled,speed};
 }
}
