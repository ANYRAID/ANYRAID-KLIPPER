import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GCodeDispatch,GCodeError} from '../src/gcode/dispatch.ts';
function setup(){const output:string[]=[],shutdown:string[]=[];const d=new GCodeDispatch({output:m=>output.push(m),shutdown:r=>shutdown.push(r)});return {d,output,shutdown};}
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
