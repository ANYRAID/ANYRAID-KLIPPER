import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GCodeDispatch,GCodeError} from '../src/gcode/dispatch.ts';
function setup(){const output:string[]=[],shutdown:string[]=[];const d=new GCodeDispatch({output:m=>output.push(m),shutdown:r=>shutdown.push(r)});return {d,output,shutdown};}
test('prefix yield reports command boundaries without checkpointing an interrupted batch',async()=>{
 let keep=true,checks=0,drains=0;const seen:string[]=[];
 const d=new GCodeDispatch({output(){},shutdown(){assert.fail('unexpected shutdown');},async checkpoint(){checks++;},async drain(){drains++;}});
 d.setReady(true);d.register('G1',c=>{seen.push(c.params.X);keep=false;});
 assert.equal(await d.executePrefix('G1 X1\nG1 X2',()=>keep),1);assert.deepEqual(seen,['1']);assert.equal(checks,0);assert.equal(drains,0);
 assert.equal(await d.executePrefix('G1 X2',()=>false),0);await d.execute('M110');assert.equal(drains,1);
 keep=true;assert.equal(await d.executePrefix('M110',()=>keep),1);assert.equal(checks,1);
});
test('readiness, extended registration and acknowledgements follow command completion',async()=>{
 const {d,output}=setup();let value='';d.register('SET_TEST',c=>{value=c.params.NAME;c.ack('done');});
 await assert.rejects(d.execute('SET_TEST NAME=x'),/not ready/);d.setReady(true);
 await d.execute('SET_TEST NAME="Mixed case"\nG999',{acknowledge:true});
 assert.equal(value,'Mixed case');assert.deepEqual(output,['!! Printer is not ready','ok done','// Unknown command:"G999"','ok']);
});
test('async commands serialize concurrent scripts and errors release admission',async()=>{
 const {d}=setup();d.setReady(true);const seen:string[]=[];let release!:()=>void;
 d.register('WAIT',async()=>{seen.push('wait');await new Promise<void>(resolve=>{release=resolve;});seen.push('done');});
 d.register('NEXT',()=>{seen.push('next');});
 const a=d.execute('WAIT'),b=d.execute('NEXT');await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(seen,['wait']);release();await Promise.all([a,b]);assert.deepEqual(seen,['wait','done','next']);
 d.register('FAIL',()=>{throw new GCodeError('bad input');});await assert.rejects(d.execute('FAIL\nNEXT'));
 await d.execute('NEXT');assert.equal(seen.length,4);
});
test('emergency stop bypasses queued waits and prevents later motion admission',async()=>{
 const {d,shutdown}=setup();d.setReady(true);let moved=false;
 d.register('WAIT',c=>new Promise<void>((resolve,reject)=>{c.signal.addEventListener('abort',()=>reject(c.signal.reason),{once:true});}));
 d.register('G1',()=>{moved=true;});const pending=d.execute('WAIT\nG1'),queued=d.execute('G1');
 await new Promise(resolve=>setImmediate(resolve));d.emergencyStop();
 await assert.rejects(pending);await assert.rejects(queued);assert.equal(moved,false);assert.equal(shutdown.length,1);
});
test('unexpected failures shut down and redact internal details, user errors can be acknowledged',async()=>{
 const {d,output,shutdown}=setup();d.setReady(true);d.register('FAIL',()=>{throw new Error('private detail');});
 await assert.rejects(d.execute('FAIL',{acknowledge:true}));assert.equal(shutdown.length,1);assert.ok(!output.join('').includes('private detail'));
 d.setReady(true);d.register('BAD',()=>{throw new GCodeError('invalid parameter');});
 await d.execute('BAD\nM110',{acknowledge:true});assert.deepEqual(output.slice(-3),['!! invalid parameter','ok','ok']);
});
test('raw text fallback, pre-ready temperature response and script resource bounds',async()=>{
 const {d,output}=setup();await d.execute('M105\nM21',{acknowledge:true});assert.deepEqual(output,['ok T:0','ok']);
 d.setReady(true);let text='';d.register('M117',c=>{text=c.rawParameters();});await d.execute('M117 123 Ready');assert.equal(text,'123 Ready');
 await assert.rejects(d.execute(' '.repeat(1048577)),/limit/);await assert.rejects(d.execute('\n'.repeat(16384)),/limit/);
});
test('shutdown invalidates queued scripts even if readiness returns before the wait settles',async()=>{
 const {d}=setup();d.setReady(true);let release!:()=>void,moved=false;
 d.register('WAIT',()=>new Promise<void>(resolve=>{release=resolve;}));d.register('G1',()=>{moved=true;});
 const active=d.execute('WAIT'),queued=d.execute('G1');await new Promise(resolve=>setImmediate(resolve));
 d.emergencyStop();d.setReady(true);release();await assert.rejects(active);await assert.rejects(queued,/invalidated/);assert.equal(moved,false);
});
test('long synchronous scripts yield to emergency input before their tail',async()=>{
 const {d}=setup();d.setReady(true);let moves=0;d.register('G1',()=>{moves++;});
 const job=d.execute(Array(1000).fill('G1 X1').join('\n'));setImmediate(()=>d.emergencyStop());
 await assert.rejects(job);assert.ok(moves>0&&moves<1000);
});
test('stream checkpoint failure shuts down and invalidates queued scripts',async()=>{
 const shutdown:string[]=[],error=new Error('stream failure');let moved=0;
 const d=new GCodeDispatch({output(){},shutdown:r=>shutdown.push(r),async checkpoint(){throw error;}});d.register('G1',()=>{moved++;});d.setReady(true);
 const active=d.execute(Array(256).fill('G1').join('\n')),queued=d.execute('G1');await assert.rejects(active,e=>e===error);await assert.rejects(queued,/invalidated/);assert(moved<256);assert.deepEqual(shutdown,['Motion checkpoint failed']);
});
test('final drain receives emergency cancellation and blocks queued commands',async()=>{
 let moved=0,entered!:()=>void;const ready=new Promise<void>(r=>{entered=r;});
 const d=new GCodeDispatch({output(){},shutdown(){},drain:s=>new Promise<void>((resolve,reject)=>{entered();s.addEventListener('abort',()=>reject(s.reason),{once:true});})});d.register('G1',()=>{moved++;});d.setReady(true);
 const active=d.execute('G1'),queued=d.execute('G1');await ready;d.emergencyStop('cancel final drain');await assert.rejects(active,/cancel final drain/);await assert.rejects(queued,/invalidated/);assert.equal(moved,1);
});
test('machine actions share script admission and retain ownership through cancellation retirement',async()=>{
 const {d,shutdown}=setup(),gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>(),cancel=new AbortController(),events:string[]=[];d.setReady(true);d.register('G1',()=>{events.push('script');});
 const action=d.runExclusive(async s=>{events.push('action');entered.resolve();await gate.promise;s.throwIfAborted();},cancel.signal),failed=assert.rejects(action);
 await entered.promise;const queued=d.execute('G1'),invalidated=assert.rejects(queued,/invalidated/);cancel.abort(new Error('cancel prepare'));await new Promise<void>(r=>setImmediate(r));assert.deepEqual(events,['action']);gate.resolve();await failed;await invalidated;assert.equal(shutdown.length,1);
});
test('queued cancelled machine work never runs and leaves the prior script healthy',async()=>{
 const {d,shutdown}=setup(),gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>(),cancel=new AbortController();d.setReady(true);d.register('G1',async()=>{entered.resolve();await gate.promise;});
 const script=d.execute('G1');await entered.promise;const action=d.runExclusive(async()=>assert.fail('cancelled queued work ran'),cancel.signal),failed=assert.rejects(action);cancel.abort();gate.resolve();await script;await failed;await d.execute('M110');assert.equal(shutdown.length,0);
});
test('machine action failure fences queued scripts and emergency stop aborts active work',async()=>{
 const {d,shutdown}=setup(),entered=Promise.withResolvers<void>();d.setReady(true);
 const action=d.runExclusive(s=>new Promise<void>((_resolve,reject)=>{s.addEventListener('abort',()=>reject(s.reason),{once:true});entered.resolve();}),new AbortController().signal),failed=assert.rejects(action);
 await entered.promise;const queued=d.execute('M110'),invalidated=assert.rejects(queued,/invalidated/);d.emergencyStop('external MCU stop');await failed;await invalidated;assert.deepEqual(shutdown,['external MCU stop']);
});
test('idle machine work skips occupied admission without accumulating deferred actions',async()=>{
 const {d,shutdown}=setup(),signal=new AbortController().signal,gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();let calls=0;
 const active=d.runExclusive(async()=>{entered.resolve();await gate.promise;},signal);await entered.promise;
 for(let i=0;i<100;i++)assert.equal(await d.runWhenIdle(async()=>{calls++;},signal),false);
 gate.resolve();await active;await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(calls,0);
 assert.equal(await d.runWhenIdle(async()=>{calls++;},signal),true);assert.equal(calls,1);assert.equal(shutdown.length,0);
});

test('pre-command drain retains the state change when a file prefix is paused',async()=>{
 let keep=true,active=false,drains=0,changes=0;const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 const d=new GCodeDispatch({output(){},shutdown(){assert.fail('unexpected shutdown');},async drain(){drains++;if(drains===1){assert(active);entered.resolve();await release.promise;}}});d.setReady(true);d.register('CHANGE_STATE',()=>{changes++;},{drainBefore:true});
 const prefix=d.executePrefix('M110\nCHANGE_STATE',()=>keep,value=>{active=value;});await entered.promise;keep=false;release.resolve();assert.equal(await prefix,1);assert.equal(changes,0);assert.equal(active,false);
 keep=true;assert.equal(await d.executePrefix('CHANGE_STATE',()=>keep,value=>{active=value;}),1);assert.equal(changes,1);
});
test('failed or cancelled pre-command drain cannot publish the state change',async()=>{
 for(const abort of [false,true]){
  let changes=0,stops=0;const d=new GCodeDispatch({output(){},shutdown(){stops++;},async drain(){if(abort)d.emergencyStop('cancelled');else throw new Error('drain failed');}});d.setReady(true);d.register('CHANGE_STATE',()=>{changes++;},{drainBefore:true});
  await assert.rejects(d.execute('CHANGE_STATE'),abort?/cancelled/:/drain failed/);assert.equal(changes,0);assert.equal(stops,1);
 }
});
test('output observers see responses and errors without changing acknowledgements or motion failure handling',async()=>{
 const {d,output,shutdown}=setup(),seen:string[]=[];
 const stop=d.observeOutput(message=>seen.push(message)),broken=d.observeOutput(()=>{throw new Error('diagnostic failed');});
 d.register('REPORT',c=>{c.respondInfo('ready\n next');c.respondRaw('raw');});d.setReady(true);
 await d.execute('REPORT',{acknowledge:true});assert.deepEqual(seen,['// ready\n// next','raw','ok']);assert.deepEqual(output,seen);assert.deepEqual(shutdown,[]);assert.equal(d.outputObservation.failures,3);
 stop();stop();broken();await d.execute('REPORT');assert.equal(seen.length,3);assert.equal(d.outputObservation.listeners,0);
 const errors:string[]=[],detach=d.observeOutput(message=>errors.push(message));d.setReady(false);
 await assert.rejects(d.execute('REPORT'),/not ready/);assert.deepEqual(errors,['!! Printer is not ready']);detach();
 const releases=Array.from({length:16},()=>d.observeOutput(()=>{}));assert.throws(()=>d.observeOutput(()=>{}),/excessive/);for(const release of releases)release();
});

test('command help reflects registrations and isolates returned descriptions from command admission',async()=>{
 const {d}=setup();assert.deepEqual(d.commandHelp(),{});
 d.register('SET_RETRACTION',()=>{});assert.equal(d.commandHelp().SET_RETRACTION,'Set firmware retraction parameters');
 assert.equal(d.commandHelp().SET_PIN,undefined);d.register('CUSTOM',()=>{},{description:'Custom test command'});
 const help=d.commandHelp();help.CUSTOM='changed';delete help.SET_RETRACTION;assert.equal(d.commandHelp().CUSTOM,'Custom test command');assert(d.commandHelp().SET_RETRACTION);
 assert.throws(()=>d.register('BAD',()=>{},{description:' '}),/description/);assert.equal(d.hasCommand('BAD'),false);
 await assert.rejects(d.execute('CUSTOM'),/not ready/);assert.equal(d.commandHelp().CUSTOM,'Custom test command');
});
