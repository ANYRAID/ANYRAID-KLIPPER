// ADC diagnostic command derived from klippy/extras/query_adc.py (GPL-3.0-or-later).
import {GCodeDispatch,GCodeError,type CommandContext} from '../gcode/dispatch.ts';
import {fixedDecimal} from '../diagnostics/python-literal.ts';
import type {ADCSample} from './adc.ts';
export interface QueryADCSource {readonly lastValue:ADCSample;}
function nameOrder(a:string,b:string):number{
 const left=Array.from(a),right=Array.from(b);
 for(let i=0;i<Math.min(left.length,right.length);i++){const delta=left[i].codePointAt(0)!-right[i].codePointAt(0)!;if(delta)return delta;}
 return left.length-right.length;
}
/** Explicit registration: reporting never schedules a sample or writes a pin. */
export class QueryADC {
 #sources=new Map<string,QueryADCSource>();
 register(name:string,source:QueryADCSource):()=>void{
  if(!name||name.length>256||/[\u0000-\u001f\u007f"\\]/u.test(name)||this.#sources.has(name)||this.#sources.size>=256)throw new RangeError('Invalid, duplicate or excessive ADC registration');
  this.#sources.set(name,source);
  let attached=true;
  return ()=>{if(attached){attached=false;this.#sources.delete(name);}};
 }
 get names():readonly string[]{return Array.from(this.#sources.keys()).sort(nameOrder);}
 report(name?:string,pullupText?:string):string{
  const source=name===undefined?undefined:this.#sources.get(name);
  if(!source)return `Available ADC objects: ${this.names.map(n=>`"${n}"`).join(', ')}`;
  const [time,value]=source.lastValue;
  if(!Number.isFinite(time)||time<0||!Number.isFinite(value)||value<0||value>1)throw new GCodeError('Invalid ADC diagnostic sample');
  let message=`ADC object "${name}" has value ${fixedDecimal(value,6)} (timestamp ${fixedDecimal(time,3)})`;
  if(pullupText!==undefined){
   const pullup=Number(pullupText);
   if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(pullupText)||!Number.isFinite(pullup)||pullup<=0)throw new GCodeError('PULLUP must be a finite positive number');
   const v=Math.max(.00001,Math.min(.99999,value)),resistance=pullup*v/(1-v);
   if(!Number.isFinite(resistance))throw new GCodeError('ADC resistance is not finite');
   message+=`\n resistance ${fixedDecimal(resistance,3)} (with ${fixedDecimal(pullup,0)} pullup)`;
  }
  return message;
 }
 attach(dispatch:GCodeDispatch):void{
  dispatch.register('QUERY_ADC',(command:CommandContext)=>command.respondInfo(this.report(command.params.NAME,command.params.PULLUP)));
 }
}
