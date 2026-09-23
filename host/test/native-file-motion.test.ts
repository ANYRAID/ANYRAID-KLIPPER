import test from 'node:test';
import assert from 'node:assert/strict';
import {bindNativeFileMotion} from '../src/operations/native-file-motion.ts';
import type {NativeLinearHomingPort} from '../src/homing/native-linear-port.ts';
const config={parkXY:[1,2] as const,retract:0,lift:1,travelSpeed:10,liftSpeed:5,retractSpeed:5},signal=()=>new AbortController().signal;
test('native file binding drains before output acknowledgement and stops both owners exactly once',async()=>{
 const events:string[]=[],gate=Promise.withResolvers<void>();const port={assertActive(){},async drain(){events.push('drain');await gate.promise;},async motorOff(){events.push('motion-stop');}} as unknown as NativeLinearHomingPort;
 const motion=bindNativeFileMotion(port,config,{prepare:async()=>{},start:async()=>{},finishOutputs:async()=>{events.push('outputs');},stopOutputs:async()=>{events.push('outputs-stop');}});
 const finish=motion.finish('job',signal());assert.deepEqual(events,['drain']);gate.resolve();await finish;assert.deepEqual(events,['drain','outputs']);const stopped=motion.stop();assert.equal(stopped,motion.stop());await stopped;assert.deepEqual(events,['drain','outputs','motion-stop','outputs-stop']);
});
test('native file stop attempts output safety even if motion stop throws synchronously',async()=>{
 let outputs=0;const port={assertActive(){},motorOff(){throw new Error('motion failure');}} as unknown as NativeLinearHomingPort;
 const motion=bindNativeFileMotion(port,config,{prepare:async()=>{},start:async()=>{},finishOutputs:async()=>{},stopOutputs:async()=>{outputs++;}});await assert.rejects(motion.stop(),AggregateError);assert.equal(outputs,1);
});
test('native file stop aborts startup ownership and prevents late success or new operations',async()=>{
 const gate=Promise.withResolvers<void>();let received:AbortSignal|undefined,starts=0;
 const port={assertActive(){},async motorOff(){}} as unknown as NativeLinearHomingPort;
 const motion=bindNativeFileMotion(port,config,{prepare:async(_r,s)=>{received=s;await gate.promise;},start:async()=>{starts++;},finishOutputs:async()=>{},stopOutputs:async()=>{}});
 const pending=motion.prepare({version:1,requestId:'job',fileId:'file',nozzle:200,bed:60},signal()),failed=assert.rejects(pending,/stopped/);await motion.stop();assert.equal(received?.aborted,true);gate.resolve();await failed;await assert.rejects(motion.start(signal()),/stopped/);assert.equal(starts,0);
});
