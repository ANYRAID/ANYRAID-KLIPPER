import assert from 'node:assert/strict';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {setImmediate} from 'node:timers/promises';
import {SystemInformation,linuxNetworkFields} from '../src/moonraker/system-information.ts';
const runs=9,warmups=2,queries=5000,changes=500,links=64;
const measurements:{observer:boolean;snapshotMicroseconds:number;refreshMicroseconds:number;p99LoopMs:number;maxLoopMs:number;events:number}[]=[];
for(let run=0;run<runs;run++)for(const observer of run%2?[true,false]:[false,true]){
 let phase=0,events=0;
 const states=[1,2].map(address=>linuxNetworkFields(JSON.stringify(Array.from({length:links},(_,i)=>({operstate:'UP',ifname:'eth'+i,link_type:'ether',address:'02:00:00:00:00:01',addr_info:[{family:'inet',local:'192.0.2.'+address,scope:'global'},{family:'inet6',local:'2001:db8::'+(i+1),scope:'global'}]})))));
 const info=new SystemInformation(async()=>({runtime:{name:'node'},...states[phase]}),observer?network=>{assert.equal(Object.keys(network).length,links);events++;}:undefined),loop=monitorEventLoopDelay({resolution:1});
 try{
  await info.refresh();loop.enable();let begin=performance.now();
  for(let i=0;i<queries;i++){const value=info.snapshot() as any;assert.equal(Object.keys(value.system_info.network).length,links);if(i%100===0)await setImmediate();}
  const snapshotMicroseconds=(performance.now()-begin)*1000/queries;begin=performance.now();
  for(let i=0;i<changes;i++){phase=1-phase;await info.refresh();if(i%10===0)await setImmediate();}
  const refreshMicroseconds=(performance.now()-begin)*1000/changes;
  assert.equal(info.status.samples,changes+1);assert.equal(events,observer?changes:0);
  if(run>=warmups)measurements.push({observer,snapshotMicroseconds,refreshMicroseconds,p99LoopMs:loop.percentile(99)/1e6,maxLoopMs:loop.max/1e6,events});
 }finally{loop.disable();await info.close();}
}
function summary(observer:boolean){const selected=measurements.filter(row=>row.observer===observer);const stats=(key:'snapshotMicroseconds'|'refreshMicroseconds'|'p99LoopMs'|'maxLoopMs')=>{const values=selected.map(row=>row[key]).sort((a,b)=>a-b);return {median:values[Math.floor(values.length/2)],p95:values[Math.ceil(values.length*.95)-1]};};return {runs:selected.length,snapshotMicroseconds:stats('snapshotMicroseconds'),refreshMicroseconds:stats('refreshMicroseconds'),p99LoopMs:stats('p99LoopMs'),maxLoopMs:stats('maxLoopMs')};}
console.log(JSON.stringify({node:process.version,queriesPerRun:queries,changesPerRun:changes,links,withoutObserver:summary(false),withObserver:summary(true),scope:'Alternating order on the same engine with 64 synthetic Linux interface rows; measures cached cloning and notification callback overhead. Actual WebSocket dispatch and motion contention are covered by the compiled load journey. No Python, target-board or physical printer comparison.'},null,2));
