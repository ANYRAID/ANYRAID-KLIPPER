/** Converter contract shared by thermistors and linear ADC sensors. */
export interface TemperatureConverter {adc(temperature:number):number;temperature(adc:number):number;}
export type ADCFaultCode='invalid-batch'|'invalid-time'|'out-of-range'|'conversion'|'callback';
export class ADCTemperature {
 readonly sampling:Readonly<{reportTime:number;sampleTime:number;sampleCount:number;rangeCheckCount:number;minimum:number;maximum:number}>;
 #converter:TemperatureConverter;#callback:(time:number,temp:number)=>void;#fault:(reason:string)=>void;#failed=false;
 #minimum:number;#maximum:number;#time:number|null=null;#value:number|null=null;#temperature:number|null=null;
 #code:ADCFaultCode|null=null;#cause:unknown;#stopError:unknown;
 constructor(converter:TemperatureConverter,minimum:number,maximum:number,callback:(time:number,temp:number)=>void,fault:(reason:string)=>void) {
  if(!Number.isFinite(minimum)||!Number.isFinite(maximum)||minimum>=maximum)throw new RangeError('Invalid ADC temperature bounds');
  const values=[converter.adc(minimum),converter.adc(maximum)].sort((a,b)=>a-b);
  if(!values.every(v=>Number.isFinite(v)&&v>=0&&v<=1)||values[0]===values[1])throw new RangeError('Invalid ADC limits');
  this.sampling=Object.freeze({reportTime:.3,sampleTime:.001,sampleCount:8,rangeCheckCount:4,minimum:values[0],maximum:values[1]});
  this.#minimum=minimum;this.#maximum=maximum;
  this.#converter=converter;this.#callback=callback;this.#fault=fault;
 }
 /** Detached diagnostic snapshot. Estimates are never sent to temperature control. */
 get status(){
  let estimatedTemperature:number|null=null;
  if(this.#code==='out-of-range'&&this.#value!==null&&this.#value>=0&&this.#value<=1){
   try{const value=this.#converter.temperature(this.#value);if(Number.isFinite(value))estimatedTemperature=value;}catch{/* An open/short circuit may not have a convertible temperature. */}
  }
  return {stopped:this.#failed,faultCode:this.#code,readTime:this.#time,rawValue:this.#value,temperature:this.#temperature,estimatedTemperature,minimumTemperature:this.#minimum,maximumTemperature:this.#maximum,minimumADC:this.sampling.minimum,maximumADC:this.sampling.maximum};
 }
 get fault():unknown{return this.#cause;}
 get stopError():unknown{return this.#stopError;}
 receive(samples:readonly (readonly [number,number])[]):void {
  if(this.#failed)throw new Error('ADC temperature sensor is stopped');
  let phase:ADCFaultCode='invalid-batch';
  // Retain only the attempted report; malformed input must not implicate a prior valid sample.
  this.#time=null;this.#value=null;this.#temperature=null;
  try {
   if(!samples.length||samples.length>4096)throw new RangeError('Invalid ADC sample batch');
   const [time,value]=samples[samples.length-1],s=this.sampling;
   this.#time=Number.isFinite(time)?time:null;this.#value=Number.isFinite(value)?value:null;
   phase='invalid-time';
   if(!Number.isFinite(time)||time<0)throw new RangeError('Invalid ADC sample time');
   phase='out-of-range';
   if(!Number.isFinite(value)||value<s.minimum||value>s.maximum)throw new RangeError('ADC sample outside configured range');
   phase='conversion';
   const temperature=this.#converter.temperature(value);
   if(!Number.isFinite(temperature))throw new RangeError('ADC temperature conversion is not finite');
   this.#temperature=temperature;
   phase='callback';this.#callback(time+s.sampleCount*s.sampleTime,temperature);
  }catch(error){
   this.#failed=true;this.#code=phase;this.#cause=error;
   try{this.#fault(`ADC temperature sensor failed: ${phase}`);}catch(stopError){this.#stopError=stopError;throw new AggregateError([error,stopError],'ADC sample and shutdown failed',{cause:error});}
   throw error;
  }
 }
}
