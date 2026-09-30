import assert from 'node:assert/strict';
import {NativeObjects,type NativeObjectReader} from '../src/moonraker/native-objects.ts';
import {NativeRequestScope} from '../src/moonraker/native-request-scope.ts';
import type {EndpointHandler} from '../src/moonraker/endpoints.ts';
import type {RpcContext} from '../src/moonraker/rpc.ts';
const readers=new Map<string,NativeObjectReader>([['toolhead',()=>({position:[1,2,3,4],homed_axes:'xyz'})],['motion_report',()=>({live_position:[1,2,3,4],live_velocity:20,live_extruder_velocity:1})]]),objects=new NativeObjects(readers,()=>performance.now()/1000),scope=new NativeRequestScope();
const handler:EndpointHandler=params=>objects.query(params.objects),wrapped=scope.wrap('/printer/objects/query',handler),iterations=8000,samples:{mode:string;wallUs:number;cpuUs:number;rss:number;heapUsed:number}[]=[];
const params={objects:{toolhead:null,motion_report:null}};let checksum=0;
// Equal input and a fresh request lifetime in both variants. Batch averages
// include allocations/GC; these are not per-request P95/P99 or network timings.
for(let batch=0;batch<3;batch++)for(const mode of ['plain','fenced','fenced','plain']){
 const call=mode==='fenced'?wrapped:handler,cpu=process.cpuUsage(),start=performance.now();
 for(let i=0;i<iterations;i++){
  const context:RpcContext={transport:'http',signal:new AbortController().signal,authorize(){}};
  const value=call(params,'GET',context) as ReturnType<NativeObjects['query']>;checksum+=value.status.toolhead.position instanceof Array?1:0;
 }
 const wallUs=(performance.now()-start)*1000/iterations,usage=process.cpuUsage(cpu),memory=process.memoryUsage();
 if(batch>0)samples.push({mode,wallUs,cpuUs:(usage.user+usage.system)/iterations,rss:memory.rss,heapUsed:memory.heapUsed});
 await new Promise<void>(resolve=>setImmediate(resolve));
}
assert.equal(checksum,iterations*12);scope.retire();assert.throws(()=>wrapped(params,'GET',{transport:'http',signal:new AbortController().signal,authorize(){}}),/retired/);
const summary=Object.fromEntries(['plain','fenced'].map(mode=>{const selected=samples.filter(s=>s.mode===mode),sorted=selected.map(s=>s.wallUs).sort((a,b)=>a-b);return [mode,{medianBatchUs:(sorted[1]+sorted[2])/2,maxBatchUs:sorted.at(-1),maxRss:Math.max(...selected.map(s=>s.rss)),maxHeapUsed:Math.max(...selected.map(s=>s.heapUsed))}];}));
console.log(JSON.stringify({node:process.version,iterations,warmup:'one ABBA block',samples,summary,scope:'Desktop synchronous two-object response construction with fresh request lifetimes. No Python, target-board or physical print comparison; high-frequency cost also requires a compiled concurrent-print regression.'}));
