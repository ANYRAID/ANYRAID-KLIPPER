/** Converter contract shared by thermistors and future linear ADC sensors. */
export interface TemperatureConverter {adc(temperature:number):number;temperature(adc:number):number;}
export class ADCTemperature {
 readonly sampling:Readonly<{reportTime:number;sampleTime:number;sampleCount:number;rangeCheckCount:number;minimum:number;maximum:number}>;
 #converter:TemperatureConverter;#callback:(time:number,temp:number)=>void;#fault:(reason:string)=>void;#failed=false;
 constructor(converter:TemperatureConverter,minimum:number,maximum:number,callback:(time:number,temp:number)=>void,fault:(reason:string)=>void) {
  if(!Number.isFinite(minimum)||!Number.isFinite(maximum)||minimum>=maximum)throw new RangeError('Invalid ADC temperature bounds');
  const values=[converter.adc(minimum),converter.adc(maximum)].sort((a,b)=>a-b);
  if(!values.every(v=>Number.isFinite(v)&&v>=0&&v<=1)||values[0]===values[1])throw new RangeError('Invalid ADC limits');
  this.sampling=Object.freeze({reportTime:.3,sampleTime:.001,sampleCount:8,rangeCheckCount:4,minimum:values[0],maximum:values[1]});
  this.#converter=converter;this.#callback=callback;this.#fault=fault;
 }
 receive(samples:readonly (readonly [number,number])[]):void {
  if(this.#failed)throw new Error('ADC temperature sensor is stopped');
  try {
   if(!samples.length||samples.length>4096)throw new RangeError('Invalid ADC sample batch');
   const [time,value]=samples[samples.length-1],s=this.sampling;
   if(!Number.isFinite(time)||time<0||!Number.isFinite(value)||value<s.minimum||value>s.maximum)throw new RangeError('ADC sample outside configured range');
   this.#callback(time+s.sampleCount*s.sampleTime,this.#converter.temperature(value));
  }catch(error){this.#failed=true;this.#fault('ADC temperature conversion or callback failed');throw error;}
 }
}
