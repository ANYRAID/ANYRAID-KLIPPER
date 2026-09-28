import test from 'node:test';
import assert from 'node:assert/strict';
import {ScheduledOutputPin,type PinOutput} from '../src/outputs/output-pin.ts';
import type {OutputPinSettings} from '../src/config/output-pin.ts';
import {OutputPinBoundaryTimeline} from '../src/outputs/output-pin-boundaries.ts';
const signal=()=>new AbortController().signal;
function fixture(overrides:Partial<OutputPinSettings>={},capacity=1024){
 const calls:number[][]=[];let resets=0,stops=0;
 const output:PinOutput={async reset(){resets++;},async stop(){stops++;},align:t=>t,async setValue(t,v){calls.push([t,v]);}};
 const settings:OutputPinSettings={section:'output_pin light',name:'light',pin:'PA2',pwm:true,hardware:false,cycleTime:.1,scale:100,initialValue:0,shutdownValue:0,...overrides};
 const runtime=new ScheduledOutputPin(output,settings,.1,capacity);
 return {runtime,output,calls,get resets(){return resets;},get stops(){return stops;}};
}
test('scaled requests coalesce during minimum scheduling intervals and suppress unchanged output',async()=>{
 const f=fixture();await f.runtime.start(()=>1,signal());
 f.runtime.enqueue(1,50);f.runtime.enqueue(1.02,60);f.runtime.enqueue(1.04,80);
 await f.runtime.flush(1.09,signal());assert.deepEqual(f.calls,[[1,.5]]);assert.equal(f.runtime.status.nextTime,1.1);
 await f.runtime.flush(1.1,signal());assert.deepEqual(f.calls,[[1,.5],[1.1,.8]]);
 f.runtime.enqueue(1.2,80);await f.runtime.flush(2,signal());assert.equal(f.calls.length,2);assert.equal(f.runtime.status.pending,0);
 await f.runtime.stop();assert.equal(f.stops,1);
});
test('alignment defers beyond the flush horizon and reconsiders requests overridden before actual output time',async()=>{
 const f=fixture();f.output.align=t=>Math.ceil(t*2)/2;await f.runtime.start(()=>1,signal());
 f.runtime.enqueue(1.1,20);f.runtime.enqueue(1.4,70);
 await f.runtime.flush(1.2,signal());assert.deepEqual(f.calls,[]);assert.equal(f.runtime.status.nextTime,1.5);
 await f.runtime.flush(1.5,signal());assert.deepEqual(f.calls,[[1.5,.7]]);await f.runtime.stop();
});
test('initial value is scheduled after reset and bounds later writes; cancellation restores a nonzero default',async()=>{
 const f=fixture({initialValue:.8,shutdownValue:.2});await f.runtime.start(()=>2,signal());assert.equal(f.resets,1);assert.deepEqual(f.calls,[[2,.8]]);
 f.runtime.enqueue(1,50);await f.runtime.flush(2,signal());assert.equal(f.calls.length,1);assert.equal(f.runtime.status.nextTime,2.1);
 await f.runtime.flush(2.1,signal());assert.deepEqual(f.calls.at(-1),[2.1,.5]);
 f.runtime.enqueue(100,90);await f.runtime.resetToDefault(signal());assert.equal(f.runtime.status.value,.2);assert.equal(f.runtime.status.pending,0);assert.equal(f.resets,2);
 f.runtime.enqueue(3,30);await f.runtime.flush(3,signal());assert.deepEqual(f.calls.at(-1),[3,.3]);await f.runtime.stop();
});
test('digital values, queue capacity and timestamp validation reject before adding requests',async()=>{
 const f=fixture({pwm:false,scale:1},1);await f.runtime.start(()=>1,signal());
 for(const value of [.5,2,NaN,Infinity])assert.throws(()=>f.runtime.enqueue(1,value));
 assert.throws(()=>f.runtime.enqueue(NaN,1));f.runtime.enqueue(1,1);assert.throws(()=>f.runtime.enqueue(2,0),/capacity/);
 await f.runtime.flush(2,signal());assert.throws(()=>f.runtime.enqueue(1,0),/time/);await assert.rejects(f.runtime.flush(1,signal()),/horizon/);
 assert.deepEqual(f.calls,[[1,1]]);await f.runtime.stop();
});
test('stop during accepted output blocks late completion and preserves terminal state',async()=>{
 const f=fixture(),gate=Promise.withResolvers<void>();await f.runtime.start(()=>1,signal());f.output.setValue=()=>gate.promise;
 f.runtime.enqueue(1,50);const flushing=f.runtime.flush(1,signal()),failed=assert.rejects(flushing,/cancel/);
 const reason=new Error('cancel');let notices=0;f.runtime.subscribeStop(cause=>{assert.equal(cause,reason);notices++;});
 const stopping=f.runtime.stop(reason);assert.equal(f.runtime.stop(),stopping);gate.resolve();await stopping;await failed;
 assert.equal(f.runtime.status.phase,'stopped');assert.equal(f.runtime.status.value,0);assert.equal(notices,1);assert.equal(f.stops,1);
});
test('nonconvergent alignment and reset failures stop rather than loop or publish readiness',async()=>{
 const f=fixture({},1);await f.runtime.start(()=>1,signal());f.output.align=t=>t+.01;f.runtime.enqueue(1,50);
 await assert.rejects(f.runtime.flush(10,signal()),/converge/);assert.equal(f.stops,1);
 const g=fixture();g.output.reset=async()=>{throw new Error('reset failed');};await assert.rejects(g.runtime.start(()=>1,signal()),/reset failed/);
 assert.equal(g.runtime.status.phase,'stopped');assert.equal(g.stops,1);
});

test('motion boundary markers settle aligned tails and retire only after the observed MCU clock',async()=>{
 const f=fixture();f.output.align=t=>Math.ceil(t*2)/2;await f.runtime.start(()=>0,signal());
 const timeline=new OutputPinBoundaryTimeline(f.runtime),a=timeline.register(20),b=timeline.register(80);
 await timeline.deliver([{id:a,time:1.1},{id:b,time:1.3}],1.3,signal());
 assert.equal(timeline.status.pending,2);assert.deepEqual(f.calls,[]);
 assert.equal(await timeline.settleScheduled(signal()),1.5);assert.deepEqual(f.calls,[[1.5,.8]]);
 timeline.retireThrough(1.4);assert.equal(timeline.status.pending,2);
 timeline.retireThrough(1.5);assert.equal(timeline.status.pending,0);await timeline.stop();
});

test('boundary replacement resets nonzero defaults and reschedules only retained markers',async()=>{
 const f=fixture({initialValue:.2,shutdownValue:.2});await f.runtime.start(()=>0,signal());
 const timeline=new OutputPinBoundaryTimeline(f.runtime),a=timeline.register(50),b=timeline.register(70);
 assert.throws(()=>timeline.register(101));assert.equal(timeline.status.pending,2);
 await timeline.deliver([{id:a,time:1},{id:b,time:2}],1,signal());timeline.retireThrough(1);
 await timeline.replace([b],signal());assert.equal(f.runtime.status.value,.2);assert.equal(f.resets,2);
 await timeline.deliver([{id:b,time:3}],3,signal());assert.deepEqual(f.calls,[[1,.5],[3,.7]]);
 await timeline.stop();assert.equal(f.runtime.status.phase,'stopped');
});

test('servo early alignment keeps nominal request spacing and rejects excess slack',async()=>{
 const f=fixture({initialValue:.05,scale:1}),runtime=new ScheduledOutputPin(f.output,{section:'servo arm',name:'arm',pin:'PA2',pwm:true,hardware:false,cycleTime:.02,scale:1,initialValue:.05,shutdownValue:0},.1,1024,.0005);
 f.output.align=t=>t-.0004;await runtime.start(()=>1,signal());
 assert.deepEqual(f.calls,[[.9996,.05]]);
 runtime.enqueue(1.01,.075);await runtime.flush(1.0999,signal());assert.equal(f.calls.length,1);
 await runtime.flush(1.1,signal());assert.deepEqual(f.calls.at(-1),[1.1-.0004,.075]);
 runtime.enqueue(1.11,.1);await runtime.flush(1.1999,signal());assert.equal(f.calls.length,2);
 f.output.align=t=>t-.0006;await assert.rejects(runtime.flush(1.3,signal()),/alignment regressed/);
 assert.equal(f.stops,1);assert.equal(f.calls.length,2);
});
