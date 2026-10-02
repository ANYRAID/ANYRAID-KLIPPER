// ADC configuration and decoding derived from klippy/mcu.py (GPL-3.0-or-later).
import {MessageDictionary,type DecodedMessage} from '../protocol/dictionary.ts';
import type {PinBinding} from '../protocol/pins.ts';
import {PrintClockTimeline,type ClockHistoryLease} from '../timing/print-clock-timeline.ts';
export const legacyADCQuery='query_analog_in oid=%c clock=%u sample_ticks=%u sample_count=%c rest_ticks=%u min_value=%hu max_value=%hu range_check_count=%c';
export const batchADCQuery='query_analog_in oid=%c clock=%u sample_ticks=%u sample_count=%c rest_ticks=%u bytes_per_report=%c min_value=%hu max_value=%hu range_check_count=%c';
export interface ADCConfig<T>{oid:number;pin:PinBinding<T>;currentPrintTime:number;reportTime:number;sampleTime?:number;sampleCount?:number;batchCount?:number;minimum?:number;maximum?:number;rangeCheckCount?:number;}
export interface CompiledADC{readonly initialClock:bigint;readonly oid:number;readonly legacy:boolean;readonly batchCount:number;readonly reportTicks:number;readonly maximumSum:number;readonly inverseMaximum:number;readonly commands:readonly string[];readonly init:readonly string[];}
const limit=0x7fffffffffffffffn;
function integer(value:unknown,min:number,max:number):value is number{return typeof value==='number'&&Number.isInteger(value)&&value>=min&&value<=max;}
function constant(d:MessageDictionary,name:string):number{const raw=d.constant(name);if(typeof raw!=='number'&&(typeof raw!=='string'||!/^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)))throw new Error(`Invalid ADC ${name}`);const value=Number(raw);if(!Number.isFinite(value))throw new Error(`Invalid ADC ${name}`);return value;}
export function compileADC<T>(chip:T,d:MessageDictionary,options:ADCConfig<T>,clockAt:(time:number)=>bigint):CompiledADC{
 const {oid,pin,currentPrintTime,reportTime}=options,sampleTime=options.sampleTime??0,sampleCount=options.sampleCount??1,batchCount=options.batchCount??1,minimum=options.minimum??0,maximum=options.maximum??1,rangeCheckCount=options.rangeCheckCount??0;
 if(!integer(oid,0,254)||pin.chip!==chip||!pin.pin||pin.pin.length>128||/[\s^~!:]/u.test(pin.pin)||pin.pullup!==0||pin.invert!==0)throw new Error('Invalid ADC pin binding');
 if(!integer(sampleCount,1,255)||!integer(batchCount,1,24)||!integer(rangeCheckCount,0,255))throw new RangeError('Invalid ADC sample counts');
 if(!Number.isFinite(minimum)||!Number.isFinite(maximum)||minimum<0||maximum>1||minimum>maximum)throw new RangeError('Invalid ADC limits');
 if(!Number.isFinite(currentPrintTime)||currentPrintTime<0||currentPrintTime+1.5<=currentPrintTime||!Number.isFinite(reportTime)||reportTime<=0||!Number.isFinite(sampleTime)||sampleTime<0)throw new RangeError('Invalid ADC timing');
 const freq=constant(d,'CLOCK_FREQ'),adcMax=constant(d,'ADC_MAX');if(freq<=0||freq>1e9||!integer(adcMax,1,65535))throw new RangeError('Invalid ADC firmware constants');
 const maximumSum=sampleCount*adcMax;if(maximumSum>=65536)throw new RangeError('ADC accumulation overflows uint16');
 const reportTicks=Math.trunc(reportTime*freq),sampleTicks=Math.trunc(sampleTime*freq);
 if(!integer(reportTicks,1,0x7fffffff)||!integer(sampleTicks,0,0x7fffffff)||sampleTime>0&&sampleTicks===0||sampleTicks*sampleCount>=reportTicks)throw new RangeError('Invalid ADC sampling tick range');
 const base=clockAt(Math.trunc(currentPrintTime+1.5));if(typeof base!=='bigint')throw new RangeError('Invalid ADC query slot');
 const initialClock=base+BigInt(Math.trunc(oid*.01*freq));if(initialClock<0n||initialClock>=limit)throw new RangeError('Invalid ADC query slot');
 let legacy=false;if(batchCount===1)try{d.lookup(legacyADCQuery);legacy=true;}catch{}
 d.lookup('config_analog_in oid=%c pin=%u');d.lookup(legacy?legacyADCQuery:batchADCQuery);d.lookup(legacy?'analog_in_state oid=%c next_clock=%u value=%hu':'analog_in_state oid=%c next_clock=%u values=%*s');
 const min=Math.trunc(minimum*maximumSum),max=Math.ceil(maximum*maximumSum);
 return Object.freeze({oid,initialClock,legacy,batchCount,reportTicks,maximumSum,inverseMaximum:1/maximumSum,commands:Object.freeze([`config_analog_in oid=${oid} pin=${pin.pin}`]),init:Object.freeze([`query_analog_in oid=${oid} clock=${BigInt.asUintN(32,initialClock)} sample_ticks=${sampleTicks} sample_count=${sampleCount} rest_ticks=${reportTicks}${legacy?'':` bytes_per_report=${batchCount*2}`} min_value=${min} max_value=${max} range_check_count=${rangeCheckCount}`])});
}
export type ADCSample=readonly [time:number,value:number];
/** Route decoded messages through SerialSession.onMessage. A thrown decoding or
 * consumer error must stop that session. Unrelated OIDs are not consumed. */
export class ADCInput{
 static withClock(config:CompiledADC,expand:(clock:number)=>bigint,clock:PrintClockTimeline,callback:(samples:readonly ADCSample[])=>void):ADCInput{
  const input=new ADCInput(config,expand,tick=>clock.printTimeAtClock(tick),callback);input.#lease=clock.retain();return input;
 }
 #lease:ClockHistoryLease|undefined;
 close():void{this.#failed=true;this.#lease?.release();this.#lease=undefined;}
 #config:CompiledADC;#expand:(clock:number)=>bigint;#printAt:(clock:bigint)=>number;#callback:(samples:readonly ADCSample[])=>void;
 #last:ADCSample=[0,0];#lastClock:bigint|undefined;#failed=false;
 constructor(config:CompiledADC,expand:(clock:number)=>bigint,printAt:(clock:bigint)=>number,callback:(samples:readonly ADCSample[])=>void){this.#config={...config};this.#expand=expand;this.#printAt=printAt;this.#callback=callback;}
 get lastValue():ADCSample{return [...this.#last];}get failed(){return this.#failed;}
 receive(message:DecodedMessage):boolean{
  const c=this.#config,p=message.parameters;if(message.name!=='analog_in_state'||p.oid!==c.oid)return false;
  if(this.#failed)throw new Error('ADC input is faulted');
  try{
   if(!integer(p.next_clock,0,0xffffffff))throw new RangeError('Invalid ADC report clock');
   const next=this.#expand(p.next_clock);if(typeof next!=='bigint'||next<0n||next>=limit)throw new RangeError('Invalid expanded ADC clock');
   let raw:number[];
   if(c.legacy){if(!integer(p.value,0,c.maximumSum))throw new RangeError('Invalid ADC sample');raw=[p.value];}
   else{const bytes=p.values;if(!(bytes instanceof Uint8Array)||bytes.length!==c.batchCount*2)throw new RangeError('Invalid ADC batch size');raw=[];for(let i=0;i<bytes.length;i+=2){const value=bytes[i]|bytes[i+1]<<8;if(value>c.maximumSum)throw new RangeError('Invalid ADC sample');raw.push(value);}}
   const first=next-BigInt(raw.length)*BigInt(c.reportTicks);if(first<0n||this.#lastClock!==undefined&&first<=this.#lastClock)throw new RangeError('ADC sample clock rewound or repeated');
   const samples:ADCSample[]=[];let clock=first,previous=this.#lastClock===undefined?-Infinity:this.#last[0];
   for(const value of raw){const time=this.#printAt(clock);if(!Number.isFinite(time)||time<0||time<=previous)throw new RangeError('Invalid ADC print time mapping');samples.push([time,value*c.inverseMaximum]);previous=time;clock+=BigInt(c.reportTicks);}
   // Validate the complete batch before publishing any sample.
   const last=samples[samples.length-1];this.#last=[last[0],last[1]];this.#lastClock=clock-BigInt(c.reportTicks);this.#callback(samples);this.#lease?.advance(this.#lastClock);return true;
  }catch(error){this.close();throw error;}
 }
}
