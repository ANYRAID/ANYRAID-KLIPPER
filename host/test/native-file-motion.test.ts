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
test('native file faults merge port and lifecycle notifications and detach on intentional stop',async()=>{
 const {StopNotice}=await import('../src/runtime/stop-notice.ts'),notice=new StopNotice(),external=new Set<(cause:unknown)=>void>(),seen:unknown[]=[];
 const port={assertActive(){},subscribeStop:(f:(cause:unknown)=>void)=>notice.subscribe(f),async motorOff(cause:unknown){notice.emit(cause);}} as unknown as NativeLinearHomingPort;
 const motion=bindNativeFileMotion(port,config,{prepare:async()=>{},start:async()=>{},finishOutputs:async()=>{},stopOutputs:async()=>{},subscribeFault(f){external.add(f);return ()=>{external.delete(f);};}});
 const listener=(cause:unknown)=>{seen.push(cause);};motion.subscribeFault!(listener);assert.throws(()=>motion.subscribeFault!(listener),/subscription/);const cause=new Error('MCU lost');notice.emit(cause);for(const f of external)f(new Error('duplicate'));assert.deepEqual(seen,[cause]);await motion.stop();assert.equal(external.size,0);motion.subscribeFault!(()=>assert.fail('intentional stop reported as a new fault'));
});
test('normal native file stop is silent and failed secondary observer binding rolls back the first',async()=>{
 const {StopNotice}=await import('../src/runtime/stop-notice.ts'),notice=new StopNotice();let calls=0;
 const port={assertActive(){},subscribeStop:(f:(cause:unknown)=>void)=>notice.subscribe(f),async motorOff(cause:unknown){notice.emit(cause);}} as unknown as NativeLinearHomingPort;
 const lifecycle={prepare:async()=>{},start:async()=>{},finishOutputs:async()=>{},stopOutputs:async()=>{},subscribeFault(){throw new Error('binding failed');}};
 const broken=bindNativeFileMotion(port,config,lifecycle);assert.throws(()=>broken.subscribeFault!(()=>{calls++;}),/binding failed/);
 const motion=bindNativeFileMotion(port,config,{...lifecycle,subscribeFault:undefined});motion.subscribeFault!(()=>{calls++;});await motion.stop();assert.equal(calls,0);
});
test('synchronous fault replay during subscription cannot retain a late disposer after stop',async()=>{
 const {StopNotice}=await import('../src/runtime/stop-notice.ts'),notice=new StopNotice();let removed=0,outputs=0;
 const port={assertActive(){},subscribeStop:(f:(cause:unknown)=>void)=>notice.subscribe(f),async motorOff(cause:unknown){notice.emit(cause);}} as unknown as NativeLinearHomingPort;
 const motion=bindNativeFileMotion(port,config,{prepare:async()=>{},start:async()=>{},finishOutputs:async()=>{},stopOutputs:async()=>{outputs++;},subscribeFault(f){f(new Error('existing fault'));return ()=>{removed++;};}});
 const off=motion.subscribeFault!(()=>{void motion.stop();});await motion.stop();off();assert.equal(removed,1);assert.equal(outputs,1);
});
