import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MoveQueueScheduler} from '../src/motion/move-queue.ts';
const p=(id:number,req:bigint,min=0n)=>({data:Buffer.from([id]),minClock:min,reqClock:req});
test('move slots gate transmission and ties preserve emitter registration order',()=>{
 const s=new MoveQueueScheduler(['x','y'],1);s.append([{id:'y',messages:[p(2,10n,20n)]},{id:'x',messages:[p(1,10n,15n),p(3,30n,40n)]}]);
 assert.deepEqual(s.flush(30n).map(p=>[p.data[0],p.minClock,p.reqClock]),[[1,0n,10n],[2,15n,10n],[3,20n,30n]]);assert.equal(s.pending,0);
});
test('only heads compete; no-slot packets can precede a deferred future move',()=>{
 const s=new MoveQueueScheduler(['x','y'],2);s.append([{id:'x',messages:[p(1,100n),p(2,101n,110n),p(3,1n)]},{id:'y',messages:[p(4,200n)]}]);
 assert.deepEqual(s.flush(50n).map(p=>p.data[0]),[1]);assert.equal(s.pending,3);
 assert.deepEqual(s.flush(110n).map(p=>p.data[0]),[2,3,4]);
});
test('append validates atomically and owns payloads while slot clocks survive flushes',()=>{
 const s=new MoveQueueScheduler(['x'],1),source=p(1,1n,10n);s.append([{id:'x',messages:[source]}]);source.data[0]=99;
 assert.throws(()=>s.append([{id:'x',messages:[p(2,2n),p(3,-1n)]}]));assert.equal(s.pending,1);assert.equal(s.flush(1n)[0].data[0],1);
 s.append([{id:'x',messages:[p(4,11n,20n)]}]);assert.equal(s.flush(11n)[0].minClock,10n);assert.throws(()=>s.flush(1n));
});
test('clock precision is retained above Number safe range and queue resources are bounded',()=>{
 const s=new MoveQueueScheduler(['x'],1),t=2n**60n;s.append([{id:'x',messages:[p(1,t,t+1n),p(2,t+2n,t+3n)]}]);assert.equal(s.flush(t+2n)[1].minClock,t+1n);
 const small=new MoveQueueScheduler(['x'],1,33);assert.throws(()=>small.append([{id:'x',messages:[p(1,1n),p(2,2n)]}]));assert.equal(small.pending,0);
 assert.throws(()=>new MoveQueueScheduler(['x'],0));assert.throws(()=>s.append([{id:'unknown',messages:[]}]));
});
import {MoveQueueSink} from '../src/motion/move-queue-sink.ts';
const out=(id:string,messages:ReturnType<typeof p>[])=>({id,messages,history:new BigInt64Array(),position:0n});
test('MCU sink routes and retains history before output, with independent slot capacity',async()=>{
 const sent:unknown[]=[];let retained=false;const transport=(id:string)=>({async send(packets:unknown){assert(retained);sent.push([id,packets]);},async stop(){assert.fail('unexpected stop');}});
 const s=new MoveQueueSink([{id:'a',emitters:['x','y'],moveSlots:1,clockAt:()=>100n,transport:transport('a')},{id:'b',emitters:['e'],moveSlots:1,clockAt:()=>100n,transport:transport('b')}],async()=>{retained=true;});
 await s.commit({sequence:0,from:0,until:1,outputs:[out('y',[p(2,10n,20n)]),out('e',[p(3,10n,20n)]),out('x',[p(1,10n,15n)])]});
 assert.deepEqual(sent,[['a',[{...p(1,10n),id:'x'},{...p(2,10n,15n),id:'y'}]],['b',[{...p(3,10n),id:'e'}]]]);
});
test('partial multi-MCU acceptance stops every device and never retries a batch',async()=>{
 let sends=0;const stops:string[]=[];const configs=['a','b'].map(id=>({id,emitters:[id],moveSlots:1,clockAt:()=>10n,transport:{async send(){sends++;if(id==='b')throw new Error('partial send');},async stop(){stops.push(id);if(id==='a')throw new Error('stop a');}}}));
 const s=new MoveQueueSink(configs,async()=>{});await assert.rejects(s.commit({sequence:0,from:0,until:1,outputs:[out('a',[p(1,1n,2n)]),out('b',[p(2,1n,2n)])]}),AggregateError);
 assert.deepEqual(stops,['a','b']);assert.equal(sends,2);await assert.rejects(s.commit({sequence:0,from:0,until:1,outputs:[]}),/stopped/);assert.equal(sends,2);
});
test('stopping during history persistence prevents every subsequent MCU send',async()=>{
 let release!:()=>void,sends=0,stops=0;
 const s=new MoveQueueSink([{id:'m',emitters:['x'],moveSlots:1,clockAt:()=>10n,transport:{async send(){sends++;},async stop(){stops++;}}}],()=>new Promise<void>(r=>{release=r;}));
 const commit=s.commit({sequence:0,from:0,until:1,outputs:[out('x',[p(1,1n,2n)])]});await s.stop(new Error('cancel'));release();await assert.rejects(commit,/stopped/);assert.equal(sends,0);assert.equal(stops,1);
});
