import test from 'node:test';
import assert from 'node:assert/strict';
import {ScheduledCoolingFan,bindCoolingFanCommands,type FanOutput} from '../src/outputs/fan.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
const signal=()=>new AbortController().signal;
function output(){const calls:number[][]=[];let resets=0,stops=0;const port:FanOutput={configuration:{initialPower:0,defaultPower:0,maximumDuration:0},reset:async()=>{resets++;},setPWM:async(t,v)=>{calls.push([t,v]);},stop:async()=>{stops++;}};return {port,calls,get resets(){return resets;},get stops(){return stops;}};}
test('fan commands queue normalized speeds and reject unmapped fan indexes',async()=>{
 const values:number[]=[],d=new GCodeDispatch({output(){},shutdown(){}});bindCoolingFanCommands(d,(value,s)=>{s.throwIfAborted();values.push(value);});d.setReady(true);
 await d.execute('M106\nM106 S127.5 P0\nM107\nM106 S510');assert.deepEqual(values,[1,.5,0,2]);
 for(const command of ['M106 S-1','M106 S'+'9'.repeat(400),'M106 P1','M107 P2'])await assert.rejects(d.execute(command));assert.deepEqual(values,[1,.5,0,2]);assert.throws(()=>bindCoolingFanCommands(d,()=>{}),/duplicate/);
});
test('fan coalesces overridden requests during kick and schedules enable transitions',async()=>{
 const o=output(),e=output(),f=new ScheduledCoolingFan(o.port,{maxPower:.8,kickStartTime:.1,offBelow:.1,minimumScheduleTime:.02},e.port);await f.start(signal());
 f.enqueue(1,.4);await f.flush(1,signal());assert.deepEqual(o.calls,[[1,.8]]);assert.deepEqual(e.calls,[[1,1]]);assert.equal(f.status.nextTime,1.1);
 f.enqueue(1.02,.5);f.enqueue(1.04,0);await f.flush(1.1,signal());assert.deepEqual(o.calls,[[1,.8],[1.1,0]]);assert.deepEqual(e.calls,[[1,1],[1.1,0]]);assert.equal(f.status.pending,0);
 f.enqueue(1.2,.05);await f.flush(1.2,signal());assert.equal(o.calls.length,2);await f.stop();assert.equal(o.stops,1);assert.equal(e.stops,1);
});
test('fan threshold, cap and boost settle at normalized power without duplicate writes',async()=>{
 const o=output(),f=new ScheduledCoolingFan(o.port,{maxPower:.8,kickStartTime:.1,offBelow:.1,minimumScheduleTime:.02});await f.start(signal());
 f.enqueue(1,.1);await f.flush(1.2,signal());assert.deepEqual(o.calls,[[1,.8],[1.1,.08000000000000002]]);
 f.enqueue(2,2);await f.flush(2.2,signal());assert.deepEqual(o.calls.at(-1),[2,.8]);assert.equal(f.status.pending,0);await f.stop();
});
test('fan off waits for generation reset and can accept a new timeline after cancelling future duty',async()=>{
 const o=output(),f=new ScheduledCoolingFan(o.port,{minimumScheduleTime:.02});await f.start(signal());f.enqueue(100,.5);await f.flush(100,signal());
 const gate=Promise.withResolvers<void>();o.port.reset=()=>gate.promise;let done=false;const off=f.off(signal()).then(()=>{done=true;});assert.throws(()=>f.enqueue(101,1),/busy/);assert.equal(done,false);
 gate.resolve();await off;assert.equal(f.status.pending,0);assert.equal(f.status.speed,0);f.enqueue(2,.2);await f.flush(2.2,signal());assert.deepEqual(o.calls.slice(-2),[[2,1],[2.1,.2]]);await f.stop();
});
test('fan stop starts both safety paths and blocks late write success',async()=>{
 const o=output(),e=output(),gate=Promise.withResolvers<void>(),f=new ScheduledCoolingFan(o.port,{minimumScheduleTime:.02},e.port);await f.start(signal());o.port.setPWM=()=>gate.promise;f.enqueue(1,.4);
 const flushing=f.flush(2,signal()),failed=assert.rejects(flushing,/stopped|cancel/);await new Promise(resolve=>setImmediate(resolve));const cause=new Error('cancel');let notices=0;f.subscribeStop(reason=>{assert.equal(reason,cause);assert.equal(o.stops,1);assert.equal(e.stops,1);notices++;});await f.stop(cause);gate.resolve();await failed;assert.equal(notices,1);assert.equal(f.status.pending,0);assert.throws(()=>f.enqueue(3,1));
});
test('fan validates times, capacity and safe defaults without truncating requests',async()=>{
 const o=output();assert.throws(()=>new ScheduledCoolingFan({...o.port,configuration:{...o.port.configuration,maximumDuration:3}},{minimumScheduleTime:.02}));
 const f=new ScheduledCoolingFan(o.port,{capacity:1,minimumScheduleTime:.02});await f.start(signal());assert.throws(()=>f.enqueue(NaN,.5));f.enqueue(1,.5);assert.throws(()=>f.enqueue(2,.5),/capacity/);assert.throws(()=>f.enqueue(.5,.2),/Invalid/);await f.flush(2,signal());await assert.rejects(f.flush(1,signal()),/horizon/);await f.stop();
});
