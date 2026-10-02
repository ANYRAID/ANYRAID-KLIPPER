import test from 'node:test';
import assert from 'node:assert/strict';
import {ScheduledOutputPin} from '../src/outputs/output-pin.ts';
import {OutputPinBoundaryTimeline} from '../src/outputs/output-pin-boundaries.ts';
import {BoundaryOutputRouter} from '../src/outputs/boundary-router.ts';
const signal=new AbortController().signal;
async function fixture(){
 const writes:{name:string;time:number;value:number}[]=[],stops:string[]=[];
 const outputs=await Promise.all(['a','b'].map(async name=>{
  const port={async reset(){},align:(t:number)=>t,async setValue(time:number,value:number){writes.push({name,time,value});},async stop(){stops.push(name);}};
  const pin=new ScheduledOutputPin(port,{section:'output_pin '+name,name,pin:'PA2',pwm:true,hardware:true,cycleTime:.1,scale:100,initialValue:0,shutdownValue:0},.1);
  await pin.start(()=>0,signal);return {name,output:new OutputPinBoundaryTimeline(pin),port};
 }));
 return {outputs,writes,stops,router:new BoundaryOutputRouter(outputs,4)};
}
test('router gives independent pins one bounded global marker namespace and retires committed prefixes',async()=>{
 const f=await fixture();try{
  const a=f.router.register(25,'a'),b=f.router.register(75,'b');assert.notEqual(a,b);
  await f.router.deliver([{id:a,time:1},{id:b,time:1}],1,signal);
  assert.deepEqual(f.writes,[{name:'a',time:1,value:.25},{name:'b',time:1,value:.75}]);
  f.router.retireThrough(.9);assert.equal(f.router.status.pending,2);f.router.retireThrough(1);assert.equal(f.router.status.pending,0);
  await f.router.deliver([{id:a,time:1},{id:b,time:1}],1,signal);assert.equal(f.writes.length,2);
  assert.throws(()=>f.router.register(1,'unknown'),/Unknown/);assert.throws(()=>f.router.register(101,'a'));
 }finally{await f.router.stop();}assert.deepEqual(f.stops,['a','b']);
});
test('unknown marker is detected before any routed writes and stops every output',async()=>{
 const f=await fixture(),id=f.router.register(25,'a');
 await assert.rejects(f.router.deliver([{id,time:1},{id:999,time:1}],1,signal),/Unknown/);
 assert.deepEqual(f.writes,[]);assert.deepEqual(f.stops,['a','b']);
});
test('router prevents duplicate ownership and propagates a single output failure to all peers',async()=>{
 const f=await fixture();assert.throws(()=>new BoundaryOutputRouter(f.outputs),/ownership/);
 f.outputs[0].port.setValue=async()=>{throw new Error('wire failed');};
 const a=f.router.register(25,'a'),b=f.router.register(75,'b');
 await assert.rejects(f.router.deliver([{id:a,time:1},{id:b,time:1}],1,signal),/wire failed|stopped/);
 assert.equal(f.router.status.stopped,true);assert.deepEqual([...f.stops].sort(),['a','b']);
});
