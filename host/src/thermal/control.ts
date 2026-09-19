// Heater control calculations from klippy/extras/heaters.py; GPL-3.0-or-later.
// Original Copyright (C) 2016-2025 Kevin O'Connor.
function positive(v:number):boolean{return Number.isFinite(v)&&v>0;}
function power(v:number):void{if(!positive(v)||v>1)throw new RangeError('Invalid heater maximum power');}
function sample(time:number,temp:number,target:number,previous:number):void {
 if(![time,temp,target].every(Number.isFinite)||time<=previous||temp< -273.15||target<0)throw new RangeError('Invalid heater sample');
}
export class PIDControl {
 #kp:number;#ki:number;#kd:number;#smooth:number;#max:number;#integralMax:number;
 #temp=25;#time=0;#derivative=0;#integral=0;
 constructor(config:{kp:number;ki:number;kd:number;smoothTime:number;maxPower:number}) {
  power(config.maxPower);
  if(![config.kp,config.ki,config.kd].every(v=>Number.isFinite(v)&&v>=0)||!positive(config.smoothTime))throw new RangeError('Invalid PID configuration');
  this.#kp=config.kp/255;this.#ki=config.ki/255;this.#kd=config.kd/255;this.#smooth=config.smoothTime;this.#max=config.maxPower;
  this.#integralMax=this.#ki?this.#max/this.#ki:0;
  if(!Number.isFinite(this.#integralMax))throw new RangeError('PID integral limit overflow');
 }
 get state(){return {temperature:this.#temp,time:this.#time,derivative:this.#derivative,integral:this.#integral};}
 /** Returns requested duty only; a separate authorization/watchdog gate must approve PWM. */
 update(time:number,temp:number,target:number):number {
  sample(time,temp,target,this.#time);const dt=time-this.#time,diff=temp-this.#temp;
  const derivative=dt>=this.#smooth?diff/dt:(this.#derivative*(this.#smooth-dt)+diff)/this.#smooth;
  const error=target-temp,integral=Math.max(0,Math.min(this.#integralMax,this.#integral+error*dt));
  const output=this.#kp*error+this.#ki*integral-this.#kd*derivative,bounded=Math.max(0,Math.min(this.#max,output));
  if(![derivative,integral,output].every(Number.isFinite))throw new RangeError('PID calculation overflow');
  this.#temp=temp;this.#time=time;this.#derivative=derivative;if(output===bounded)this.#integral=integral;
  return bounded;
 }
 busy(smoothed:number,target:number):boolean {
  if(![smoothed,target].every(Number.isFinite))throw new RangeError('Invalid heater status');
  return Math.abs(target-smoothed)>1||Math.abs(this.#derivative)>.1;
 }
}
export class BangBangControl {
 #heating=false;#time=0;#max:number;#delta:number;
 constructor(maxPower:number,maxDelta=2){power(maxPower);if(!positive(maxDelta))throw new RangeError('Invalid heater hysteresis');this.#max=maxPower;this.#delta=maxDelta;}
 get heating():boolean{return this.#heating;}
 update(time:number,temp:number,target:number):number {
  sample(time,temp,target,this.#time);
  if(this.#heating&&temp>=target+this.#delta)this.#heating=false;
  else if(!this.#heating&&temp<=target-this.#delta)this.#heating=true;
  this.#time=time;return this.#heating?this.#max:0;
 }
 busy(smoothed:number,target:number):boolean {
  if(![smoothed,target].every(Number.isFinite))throw new RangeError('Invalid heater status');return smoothed<target-this.#delta;
 }
}
/** Pure scheduling gate. Caller must enforce hardware max-duration and actual shutdown. */
export class HeaterPWM {
 #max:number;#delay:number;#validUntil=-999;#lastHeartbeat=-Infinity;#lastSample=0;
 #next=0;#value=0;#stopped=false;
 constructor(maxPower:number,reportDelay:number){power(maxPower);if(!positive(reportDelay)||reportDelay>=1)throw new RangeError('Invalid heater report delay');this.#max=maxPower;this.#delay=reportDelay;}
 heartbeat(estimatedPrintTime:number):void {
  if(this.#stopped)throw new Error('Heater PWM is shut down');
  if(!Number.isFinite(estimatedPrintTime)||estimatedPrintTime<0||estimatedPrintTime<this.#lastHeartbeat)throw new RangeError('Invalid heater heartbeat');
  this.#lastHeartbeat=estimatedPrintTime;this.#validUntil=estimatedPrintTime+5;
 }
 shutdown():void {this.#stopped=true;this.#validUntil=-999;}
 /** Call only after the output adapter has cancelled queued power and forced zero. */
 confirmOff():void {this.#value=0;this.#next=0;}
 update(readTime:number,requested:number,target:number):{time:number;power:number}|undefined {
  if(![readTime,requested,target].every(Number.isFinite)||readTime<=this.#lastSample||requested<0||requested>this.#max||target<0)throw new RangeError('Invalid PWM request');
  const value=target<=0||readTime>this.#validUntil||this.#stopped?0:requested;
  this.#lastSample=readTime;
  // Never suppress an off transition, including previously small nonzero duty.
  if(!(value===0&&this.#value!==0)&&(readTime<this.#next||!this.#value)&&Math.abs(value-this.#value)<this.#max*.05)return;
  const time=readTime+this.#delay;this.#next=time+3-(3*this.#delay+.001);this.#value=value;
  return {time,power:value};
 }
}
