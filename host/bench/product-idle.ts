import assert from 'node:assert/strict';
import {ProductIdleTimeout} from '../src/operations/product-idle.ts';
const durations:number[]=[];
for(let run=0;run<13;run++){
 let now=0,next:(()=>void)|undefined,actions=0;const state={position:[0,0,0,0],motors:[true,true,true,true],targets:[210,60]};
 const owner=new ProductIdleTimeout(600,{now:()=>now,schedule(fn){assert.equal(next,undefined);next=fn;return ()=>{next=undefined;};}},()=>({busy:true,printing:true,key:JSON.stringify(['printing',state.position,'xyz',state.motors,state.targets])}),async()=>{actions++;},error=>{throw error;});
 const start=performance.now();for(let i=0;i<20000;i++){now++;const callback=next;next=undefined;assert(callback);callback();}const elapsed=performance.now()-start;assert.equal(actions,0);assert.equal(owner.status.state,'Printing');owner.close();assert.equal(next,undefined);if(run>=2)durations.push(elapsed);
}
durations.sort((a,b)=>a-b);assert(durations[10]<1000);console.log(JSON.stringify({node:process.version,polls:20000,samples:11,medianMs:durations[5],p95Ms:durations[10],scope:'Idle observation with representative activity key and bounded synthetic timer; no physical output latency'},null,2));
