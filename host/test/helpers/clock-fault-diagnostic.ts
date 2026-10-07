import type {MockTracker} from 'node:test';
import {ClockRuntime} from '../../src/timing/clock-runtime.ts';
import {ClockSync} from '../../src/timing/clock-sync.ts';
import {captureClockSamples} from './clock-sample-diagnostic.ts';

type ErrorSnapshot={name:string;message:string;cause?:ErrorSnapshot};
type Retirement={runtime:number;time:number;state:string;fault:ErrorSnapshot|undefined;stopError:ErrorSnapshot|undefined;samples:ReturnType<ReturnType<typeof captureClockSamples>['snapshot']>[number]};
function errorSnapshot(value:unknown,depth=0):ErrorSnapshot|undefined{
 if(value===undefined)return;
 if(!(value instanceof Error))return {name:typeof value,message:String(value)};
 return {name:value.name,message:value.message,...depth<3&&value.cause!==undefined?{cause:errorSnapshot(value.cause,depth+1)}:{}};
}
/** Test-only first retirement observation. Save references before startup so
 * failed owners need no MCUGroup.session() access. The original start and
 * invalidate methods run once; no query, timer, clock or motion is added. */
export function captureClockFaults(mock:MockTracker,now:()=>number,observe?:(row:Retirement)=>void){
 const samples=captureClockSamples(mock),runtimes:ClockRuntime[]=[];
 const start=ClockRuntime.prototype.start,invalidate=ClockSync.prototype.invalidate;
 const retirements:Retirement[]=[],observerErrors:ErrorSnapshot[]=[];
 mock.method(ClockRuntime.prototype,'start',function(this:ClockRuntime){
  if(!runtimes.includes(this))runtimes.push(this);
  return start.call(this);
 });
 mock.method(ClockSync.prototype,'invalidate',function(this:ClockSync){
  let observed:Retirement|undefined;
  const index=runtimes.findIndex(runtime=>{try{return runtime.sync===this;}catch{return false;}});
  if(index>=0&&!retirements.some(row=>row.runtime===index)){
   const state=runtimes[index].status;
   observed={runtime:index,time:now(),state:state.state,fault:errorSnapshot(state.fault),stopError:errorSnapshot(state.stopError),samples:samples.snapshot([{id:String(index),sync:this}])[0]};retirements.push(observed);
  }
  const result=invalidate.call(this);
  if(observed&&observe){try{observe(structuredClone(observed));}catch(error){observerErrors.push(errorSnapshot(error)!);}}
  return result;
 });
 return {snapshot(){return structuredClone({retirements,observerErrors,owners:runtimes.map((runtime,index)=>{
  let sync:ClockSync|undefined;try{sync=runtime.sync;}catch{/* Uptime may fail before initialization. */}
  const state=runtime.status;
  return {runtime:index,state:state.state,fault:errorSnapshot(state.fault),stopError:errorSnapshot(state.stopError),samples:sync?samples.snapshot([{id:String(index),sync}])[0]:undefined};
 })});}};
}
