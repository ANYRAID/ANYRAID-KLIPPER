// Temperature state from klippy/extras/heaters.py; GPL-3.0-or-later.
// Original Copyright (C) 2016-2025 Kevin O'Connor.
export interface TemperatureConfig {minimum:number;maximum:number;minimumExtrude:number;smoothTime:number;sampleTimeout?:number;}
/** All times are MCU-estimated print time, not wall-clock or host monotonic time. */
export class TemperatureState {
 #config:TemperatureConfig;#inverseSmooth:number;#target=0;#last=0;#time=0;#smooth=0;#received=false;#fault:string|undefined;
 constructor(config:TemperatureConfig) {
  if(![config.minimum,config.maximum,config.minimumExtrude,config.smoothTime].every(Number.isFinite)||config.minimum< -273.15||config.maximum<=config.minimum
   ||config.minimumExtrude<config.minimum||config.smoothTime<=0)throw new RangeError('Invalid temperature configuration');
  if(!Number.isFinite(config.sampleTimeout??7)||(config.sampleTimeout??7)<=0||(config.sampleTimeout??7)>86406)throw new RangeError('Invalid temperature sample timeout');
  this.#config={...config};this.#inverseSmooth=1/config.smoothTime;
  if(!Number.isFinite(this.#inverseSmooth))throw new RangeError('Temperature smoothing overflow');
 }
 get limits(){return {minimum:this.#config.minimum,maximum:this.#config.maximum};}
 get state(){return {target:this.#target,lastTemperature:this.#last,lastTime:this.#time,smoothedTemperature:this.#smooth,received:this.#received,fault:this.#fault};}
 setTarget(target:number):void {
  if(!Number.isFinite(target)||target<0||(target!==0&&(target<this.#config.minimum||target>this.#config.maximum)))throw new RangeError('Requested temperature out of range');
  if(this.#fault&&target!==0)throw new Error('Temperature state is shut down');this.#target=target;
 }
 shutdown(reason='Heater shut down'):void {this.#fault??=reason;this.#target=0;}
 sample(readTime:number,temperature:number):void {
  if(this.#fault)throw new Error('Temperature state is shut down');
  if(!Number.isFinite(readTime)||readTime<=this.#time||!Number.isFinite(temperature)||temperature<this.#config.minimum||temperature>this.#config.maximum) {
   this.shutdown('Invalid or out-of-range temperature sample');throw new RangeError(this.#fault);
  }
  const dt=readTime-this.#time,adjustment=Math.min(dt*this.#inverseSmooth,1),smoothed=this.#smooth+(temperature-this.#smooth)*adjustment;
  if(!Number.isFinite(smoothed)){this.shutdown('Temperature calculation overflow');throw new RangeError(this.#fault);}
  this.#last=temperature;this.#time=readTime;this.#smooth=smoothed;this.#received=true;
 }
 status(estimatedPrintTime:number):{temperature:number;target:number;canExtrude:boolean;stale:boolean;fault:string|undefined} {
  if(!Number.isFinite(estimatedPrintTime)||estimatedPrintTime<0)throw new RangeError('Invalid temperature query time');
  const stale=!this.#received||this.#time<estimatedPrintTime-(this.#config.sampleTimeout??7);
  return {temperature:stale?0:this.#smooth,target:this.#target,canExtrude:!this.#fault&&!stale&&this.#smooth>=this.#config.minimumExtrude,stale,fault:this.#fault};
 }
}
