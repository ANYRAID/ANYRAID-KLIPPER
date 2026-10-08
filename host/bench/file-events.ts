import {mkdtemp,open,writeFile,rm,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {FileEvents,fileEventMask as mask} from '../src/moonraker/file-events.ts';
const output=process.argv[2];if(!output)throw new Error('Provide a new JSON report path');
const samples=16384,batch=8,warmups=256,phases=[];
for(const enabled of [false,true,true,false]){
 const directory=await mkdtemp(join(tmpdir(),'file-events-bench-')),root=await open(directory,'r');let received=0,closes=0,fault:unknown;
 const observer=enabled?new FileEvents(events=>{received+=events.length;for(const event of events)if(event.mask&mask.closeWrite)closes++;},error=>{fault=error;}):undefined;
 const wait=async(target:number)=>{const deadline=performance.now()+5000;while(observer&&closes<target){if(fault)throw fault;if(performance.now()>deadline)throw new Error('Lost benchmark close-write events');await new Promise<void>(resolve=>setTimeout(resolve,1));}};
 try{
  observer?.add(root);for(let i=0;i<warmups;i++)await writeFile(join(directory,'warm-'+i),'closed archive');await wait(warmups);
  const histogram=monitorEventLoopDelay({resolution:1}),latencies:number[]=[];histogram.enable();await new Promise<void>(resolve=>setTimeout(resolve,20));histogram.reset();const before=performance.now();
  for(let first=0;first<samples;first+=batch){const start=performance.now();await Promise.all(Array.from({length:batch},(_,offset)=>writeFile(join(directory,'part-'+(first+offset)+'.ufp'),'closed archive')));latencies.push(performance.now()-start);}
  await wait(samples+warmups);const elapsedMs=performance.now()-before;await new Promise<void>(resolve=>setTimeout(resolve,10));histogram.disable();latencies.sort((a,b)=>a-b);
  phases.push({enabled,samples,batch,warmups,elapsedMs,batchMedianMs:latencies[Math.floor(latencies.length/2)],batchP95Ms:latencies[Math.ceil(latencies.length*.95)-1],batchP99Ms:latencies[Math.ceil(latencies.length*.99)-1],batchLatenciesMs:latencies,loopP99Ms:histogram.percentile(99)/1e6,loopMaxMs:histogram.max/1e6,events:received,closeWrites:closes});
  if(fault)throw fault;
 }finally{await observer?.close();await root.close();await rm(directory,{recursive:true,force:true});}
}
await mkdir(join(output,'..'),{recursive:true});await writeFile(output,JSON.stringify({schema:1,node:process.version,phases,scope:'Local ABBA disk event overhead with 8 concurrent small writes per batch, actual close-write callbacks and identical file operations. No printer, target board, import conversion or motion precision acceptance.'},null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(phases.map(({batchLatenciesMs,...summary})=>summary)));
