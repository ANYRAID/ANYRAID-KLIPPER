// Combined temperature semantics from temperature_combined.py; GPL-3.0-or-later.
export type CombinationMethod='min'|'max'|'mean';
export type AdditionalField='humidity'|'pressure'|'gas';
const emptyFields=Object.freeze({});
const fields:readonly AdditionalField[]=['humidity','pressure','gas'];
export interface CombinedReading {temperature:number;stale:boolean;fault?:unknown;humidity?:number|null;pressure?:number|null;gas?:number|null;}
export interface CombinedTemperatureConfig {method:CombinationMethod;maximumDeviation:number;minimum:number;maximum:number;}
/** Inputs are live snapshots from owners responsible for sample freshness.
 * No fabricated initial zero or stale last value is admitted as a reading. */
export class CombinedTemperature {
 readonly #config:Readonly<CombinedTemperatureConfig>;readonly #sources:readonly (()=>CombinedReading)[];
 #fault:Error|undefined;#last:number|undefined;#additional:Partial<Record<AdditionalField,number>>=emptyFields;
 get additional(){return {...this.#additional};}
 constructor(config:CombinedTemperatureConfig,sources:readonly (()=>CombinedReading)[]){
  if(!['min','max','mean'].includes(config.method)||![config.maximumDeviation,config.minimum,config.maximum].every(Number.isFinite)||config.maximumDeviation<=0||config.minimum< -273.15||config.maximum<=config.minimum||sources.length<1||sources.length>128||sources.some(s=>typeof s!=='function'))throw new RangeError('Invalid combined temperature configuration');
  this.#config=Object.freeze({...config});this.#sources=Object.freeze([...sources]);
 }
 sample():number{
  if(this.#fault)throw this.#fault;
  try{
   let minimum=Infinity,maximum=-Infinity,mean=0,correction=0;
   let samples:Partial<Record<AdditionalField,number[]>>|undefined;
   for(const read of this.#sources){const value=read();if(value.stale||value.fault!==undefined||!Number.isFinite(value.temperature))throw new Error('Combined temperature source unavailable');
    if(value.humidity!=null||value.pressure!=null||value.gas!=null)for(const field of fields){const v=value[field];if(v===undefined||v===null)continue;if(!Number.isFinite(v))throw new Error('Invalid combined '+field+' reading');samples??={};(samples[field]??=[]).push(v);}
    const t=value.temperature;minimum=Math.min(minimum,t);maximum=Math.max(maximum,t);
    // Compensated, scaled summation avoids overflowing a sum of finite inputs.
    const part=t/this.#sources.length-correction,next=mean+part;correction=(next-mean)-part;mean=next;
   }
   if(maximum-minimum>this.#config.maximumDeviation)throw new Error('Combined temperature maximum deviation exceeded');
   const result=this.#config.method==='min'?minimum:this.#config.method==='max'?maximum:mean;
   if(!Number.isFinite(result)||result<this.#config.minimum||result>this.#config.maximum)throw new Error('Combined temperature outside configured range');
   const additional:Partial<Record<AdditionalField,number>>=samples?{}:emptyFields;
   if(samples)for(const field of fields){const values=samples[field];if(!values)continue;let lo=Infinity,hi=-Infinity,average=0,error=0;for(const v of values){lo=Math.min(lo,v);hi=Math.max(hi,v);const part=v/values.length-error,next=average+part;error=(next-average)-part;average=next;}const combined=this.#config.method==='min'?lo:this.#config.method==='max'?hi:average;if(!Number.isFinite(combined))throw new Error('Combined '+field+' overflow');additional[field]=combined;}
   this.#additional=additional;this.#last=result;return result;
  }catch(cause){this.#fault=cause instanceof Error?cause:new Error('Combined temperature source failed',{cause});throw this.#fault;}
 }
 getTemperature():CombinedReading{return {...this.#additional,temperature:this.#last??0,stale:this.#last===undefined||this.#fault!==undefined,...this.#fault?{fault:this.#fault}:{}};}
}
