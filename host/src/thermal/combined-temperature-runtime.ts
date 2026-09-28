import {CombinedTemperature,type CombinedReading,type CombinedTemperatureConfig} from './combined-temperature.ts';
import {TemperatureSensorState} from './temperature-sensor.ts';
type Schedule=(callback:()=>void,milliseconds:number)=>()=>void;
const schedule:Schedule=(callback,ms)=>{const timer=setTimeout(callback,ms);timer.unref();return ()=>clearTimeout(timer);};
/** Configured owner samples after source startup, then every 300 ms. Any
 * invalid source or observer failure latches shutdown; closing cancels polling. */
export class CombinedTemperatureRuntime {
 readonly state=new TemperatureSensorState();readonly section:string;
 readonly #combined:CombinedTemperature;readonly #fault:(cause:unknown)=>void;readonly #schedule:Schedule;
 #cancel:(()=>void)|undefined;#started=false;#closed=false;
 constructor(section:string,config:CombinedTemperatureConfig,sources:readonly (()=>CombinedReading)[],fault:(cause:unknown)=>void,timer:Schedule=schedule){this.section=section;this.#combined=new CombinedTemperature(config,sources);this.#fault=fault;this.#schedule=timer;}
 start():void{if(this.#started||this.#closed)throw new Error('Combined temperature cannot restart');this.#started=true;this.#cancel=this.#schedule(()=>this.#sample(),1000);}
 #sample():void{
  if(this.#closed)return;
  try{this.state.sample(performance.now()/1000,this.#combined.sample());if(!this.#closed)this.#cancel=this.#schedule(()=>this.#sample(),300);}
  catch(cause){this.close(cause);this.#fault(cause);}
 }
 close(cause:unknown=new Error('Combined temperature stopped')):void{if(this.#closed)return;this.#closed=true;this.#cancel?.();this.state.shutdown(cause instanceof Error?cause.message:'Combined temperature stopped');}
}
