// Combined temperature semantics from temperature_combined.py; GPL-3.0-or-later.
export type CombinationMethod='min'|'max'|'mean';
export interface CombinedReading {temperature:number;stale:boolean;fault?:unknown;}
export interface CombinedTemperatureConfig {method:CombinationMethod;maximumDeviation:number;minimum:number;maximum:number;}
/** Inputs are live snapshots from owners responsible for sample freshness.
 * No fabricated initial zero or stale last value is admitted as a reading. */
export class CombinedTemperature {
 readonly #config:Readonly<CombinedTemperatureConfig>;readonly #sources:readonly (()=>CombinedReading)[];
 #fault:Error|undefined;#last:number|undefined;
 constructor(config:CombinedTemperatureConfig,sources:readonly (()=>CombinedReading)[]){
  if(!['min','max','mean'].includes(config.method)||![config.maximumDeviation,config.minimum,config.maximum].every(Number.isFinite)||config.maximumDeviation<=0||config.minimum< -273.15||config.maximum<=config.minimum||sources.length<1||sources.length>128||sources.some(s=>typeof s!=='function'))throw new RangeError('Invalid combined temperature configuration');
  this.#config=Object.freeze({...config});this.#sources=Object.freeze([...sources]);
 }
 sample():number{
  if(this.#fault)throw this.#fault;
  try{
   let minimum=Infinity,maximum=-Infinity,mean=0,correction=0;
   for(const read of this.#sources){const value=read();if(value.stale||value.fault!==undefined||!Number.isFinite(value.temperature))throw new Error('Combined temperature source unavailable');
    const t=value.temperature;minimum=Math.min(minimum,t);maximum=Math.max(maximum,t);
    // Compensated, scaled summation avoids overflowing a sum of finite inputs.
    const part=t/this.#sources.length-correction,next=mean+part;correction=(next-mean)-part;mean=next;
   }
   if(maximum-minimum>this.#config.maximumDeviation)throw new Error('Combined temperature maximum deviation exceeded');
   const result=this.#config.method==='min'?minimum:this.#config.method==='max'?maximum:mean;
   if(!Number.isFinite(result)||result<this.#config.minimum||result>this.#config.maximum)throw new Error('Combined temperature outside configured range');
   this.#last=result;return result;
  }catch(cause){this.#fault=cause instanceof Error?cause:new Error('Combined temperature source failed',{cause});throw this.#fault;}
 }
 getTemperature():CombinedReading{return {temperature:this.#last??0,stale:this.#last===undefined||this.#fault!==undefined,...this.#fault?{fault:this.#fault}:{}};}
}
