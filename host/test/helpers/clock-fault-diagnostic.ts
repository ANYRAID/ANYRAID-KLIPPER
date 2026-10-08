import type {MockTracker} from 'node:test';
import {ClockRuntime,type UptimeSample} from '../../src/timing/clock-runtime.ts';
import {ClockSync} from '../../src/timing/clock-sync.ts';
import {DictionaryClockTransport} from '../../src/protocol/clock-transport.ts';
import {captureClockSamples} from './clock-sample-diagnostic.ts';

type ErrorSnapshot={name:string;message:string;cause?:ErrorSnapshot};
type UptimeCapture={transport:number;sample:UptimeSample};
type Retirement={runtime:number;time:number;state:string;fault:ErrorSnapshot|undefined;stopError:ErrorSnapshot|undefined;uptime:{count:number;recent:UptimeCapture[]};samples:ReturnType<ReturnType<typeof captureClockSamples>['snapshot']>[number]};
function errorSnapshot(value:unknown,depth=0):ErrorSnapshot|undefined{
 if(value===undefined)return;
 if(!(value instanceof Error))return {name:typeof value,message:String(value)};
 return {name:value.name,message:value.message,...depth<3&&value.cause!==undefined?{cause:errorSnapshot(value.cause,depth+1)}:{}};
}
/** Test-only first retirement observation. Save references before startup so
 * failed owners need no MCUGroup.session() access. The original start and
 * invalidate methods run once; no query, timer, clock or motion is added.
 * Retain up to 16 original uptime replies to distinguish initialization RTT
 * from later warmup/outlier behavior. Transport IDs are observation order;
 * match to initial estimator anchors by sentTime and exact uptime counter. */
export function captureClockFaults(mock:MockTracker,now:()=>number,observe?:(row:Retirement)=>void){
 const samples=captureClockSamples(mock),runtimes:ClockRuntime[]=[];
 const start=ClockRuntime.prototype.start,invalidate=ClockSync.prototype.invalidate;
 const retirements:Retirement[]=[],observerErrors:ErrorSnapshot[]=[];
 const uptimes:UptimeCapture[]=[],transports=new WeakMap<DictionaryClockTransport,number>();let uptimeCount=0,nextTransport=0;const uptime=DictionaryClockTransport.prototype.uptime;
 mock.method(DictionaryClockTransport.prototype,'uptime',async function(this:DictionaryClockTransport,signal:AbortSignal){const sample=await uptime.call(this,signal);if(!transports.has(this))transports.set(this,nextTransport++);uptimeCount++;uptimes.push({transport:transports.get(this)!,sample:{...sample}});if(uptimes.length>16)uptimes.shift();return sample;});
 mock.method(ClockRuntime.prototype,'start',function(this:ClockRuntime){
  if(!runtimes.includes(this))runtimes.push(this);
  return start.call(this);
 });
 mock.method(ClockSync.prototype,'invalidate',function(this:ClockSync){
  let observed:Retirement|undefined;
  const index=runtimes.findIndex(runtime=>{try{return runtime.sync===this;}catch{return false;}});
  if(index>=0&&!retirements.some(row=>row.runtime===index)){
   const state=runtimes[index].status;
   observed={runtime:index,time:now(),state:state.state,fault:errorSnapshot(state.fault),stopError:errorSnapshot(state.stopError),uptime:structuredClone({count:uptimeCount,recent:uptimes}),samples:samples.snapshot([{id:String(index),sync:this}])[0]};retirements.push(observed);
  }
  const result=invalidate.call(this);
  if(observed&&observe){try{observe(structuredClone(observed));}catch(error){observerErrors.push(errorSnapshot(error)!);}}
  return result;
 });
 return {snapshot(){return structuredClone({retirements,observerErrors,uptime:{count:uptimeCount,recent:uptimes},owners:runtimes.map((runtime,index)=>{
  let sync:ClockSync|undefined;try{sync=runtime.sync;}catch{/* Uptime may fail before initialization. */}
  const state=runtime.status;
  return {runtime:index,state:state.state,fault:errorSnapshot(state.fault),stopError:errorSnapshot(state.stopError),samples:sync?samples.snapshot([{id:String(index),sync}])[0]:undefined};
 })});}};
}
