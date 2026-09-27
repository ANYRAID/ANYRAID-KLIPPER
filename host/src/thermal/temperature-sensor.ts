// Generic sensor statistics from klippy/extras/temperature_sensor.py; GPL-3.0-or-later.
import {fixedDecimal} from '../diagnostics/python-literal.ts';
export class TemperatureSensorState {
 #last=0;#minimum=99999999;#maximum=0;#received=false;#fault:string|undefined;
 sample(_time:number,temperature:number):void{
  if(this.#fault!==undefined)throw new Error('Temperature sensor stopped');
  if(!Number.isFinite(temperature))throw new RangeError('Invalid sensor temperature');
  this.#last=temperature;this.#received=true;
  if(temperature){this.#minimum=Math.min(this.#minimum,temperature);this.#maximum=Math.max(this.#maximum,temperature);}
 }
 shutdown(reason:string):void{this.#fault??=reason;}
 getTemperature(){return {temperature:this.#last,target:0,stale:!this.#received||this.#fault!==undefined,...this.#fault===undefined?{}:{fault:this.#fault}};}
 get objectStatus(){const round=(n:number)=>Number(fixedDecimal(n,2));return {temperature:round(this.#last),measured_min_temp:round(this.#minimum),measured_max_temp:round(this.#maximum)};}
}
