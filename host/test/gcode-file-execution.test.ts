import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GCodeFileReader} from '../src/gcode/file-reader.ts';
import {GCodeFileExecution} from '../src/gcode/file-execution.ts';
import {GCodeDispatch,GCodeError,type CommandContext} from '../src/gcode/dispatch.ts';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(script:string,handler:(command:CommandContext)=>void|Promise<void>,onStop:()=>void=()=>{},batchLines=1,checkpoint?:(signal:AbortSignal)=>Promise<void>){
 const directory=await mkdtemp(join(tmpdir(),'file-execution-')),path=join(directory,'file.gcode');await writeFile(path,script);const reader=await GCodeFileReader.adopt(await open(path,'r'),{batchLines});let stops=0;
 const dispatch=new GCodeDispatch({checkpoint,output(){},shutdown(){stops++;onStop();}});dispatch.register('G1',handler);dispatch.setReady(true);const execution=new GCodeFileExecution(reader,dispatch);
 return {reader,execution,dispatch,get stops(){return stops;},async close(){try{await execution.stop();}finally{await rm(directory,{recursive:true,force:true});}}};
}
test('EOF resolves only after all commands and successful commits; no normal emergency stop',async()=>{
 const gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>(),moves:string[]=[];
 const f=await fixture('G1 X1\nG1 X2\n',async command=>{moves.push(command.params.X);if(moves.length===2){entered.resolve();await gate.promise;}});
 try{const done=f.execution.start();assert.equal(done,f.execution.start());await entered.promise;assert.equal(f.execution.status.position,6);assert.equal(f.execution.status.eof,false);gate.resolve();await done;assert.deepEqual(moves,['1','2']);assert.equal(f.execution.status.phase,'eof');assert.equal(f.execution.status.position,12);assert.equal(f.execution.status.closed,true);assert.equal(f.stops,0);}finally{await f.close();}
});
test('pause waits current batch then prevents admission until explicit resume',async()=>{
 const gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();let moves=0;
 const f=await fixture('G1 X1\nG1 X2\n',async()=>{moves++;if(moves===1){entered.resolve();await gate.promise;}});
 try{const done=f.execution.start();await entered.promise;const paused=f.execution.pause();assert.equal(paused,f.execution.pause());await flush();assert.equal(f.execution.status.phase,'pausing');gate.resolve();await paused;await flush();assert.equal(moves,1);assert.equal(f.execution.status.phase,'paused');assert.equal(f.execution.status.position,6);f.execution.resume();await done;assert.equal(moves,2);}finally{await f.close();}
});
test('stop aborts active handler and never admits following file commands',async()=>{
 const entered=Promise.withResolvers<void>();let moves=0;
 const f=await fixture('G1 X1\nG1 X2\n',command=>{moves++;entered.resolve();return new Promise((_resolve,reject)=>command.signal.addEventListener('abort',()=>reject(command.signal.reason),{once:true}));});
 try{const done=f.execution.start(),rejected=assert.rejects(done);await entered.promise;const stop=f.execution.stop();assert.equal(stop,f.execution.stop());await stop;await rejected;assert.equal(moves,1);assert.equal(f.execution.status.position,0);assert.equal(f.execution.status.phase,'stopped');assert.equal(f.stops,1);}finally{await f.close();}
});
test('script error or truncated file ends execution without a successful EOF',async()=>{
 for(const script of ['G1 X1\nG1 X2\n','G1 X1']){
  const f=await fixture(script,()=>{throw new GCodeError('move rejected');});try{await assert.rejects(f.execution.start());assert.equal(f.execution.status.phase,'failed');assert.equal(f.execution.status.eof,false);assert.equal(f.execution.status.position,0);assert.equal(f.stops,1);assert.equal(f.execution.status.closed,true);}finally{await f.close();}
 }
});
test('pause before pump admission is respected and stop wakes paused execution',async()=>{
 let moves=0;const f=await fixture('G1 X1\n',()=>{moves++;});try{const done=f.execution.start(),rejected=assert.rejects(done);await f.execution.pause();await flush();assert.equal(moves,0);await f.execution.stop();await rejected;assert.equal(f.execution.status.phase,'stopped');await assert.rejects(f.execution.pause(),/not running/);}finally{await f.close();}
});

test('stop waits for an uncooperative handler and never commits its late result',async()=>{
 const entered=Promise.withResolvers<void>(),gate=Promise.withResolvers<void>();const f=await fixture('G1 X1\n',async()=>{entered.resolve();await gate.promise;});
 try{const done=f.execution.start(),rejected=assert.rejects(done);await entered.promise;let stopped=false;const stop=f.execution.stop().then(()=>{stopped=true;});await flush();assert.equal(stopped,false);assert.equal(f.execution.status.phase,'stopping');gate.resolve();await stop;await rejected;assert.equal(f.execution.status.position,0);}finally{await f.close();}
});
test('shutdown hook failure is retained while the file descriptor still closes',async()=>{
 const f=await fixture('G1 X1\n',()=>{throw new GCodeError('command failed');},()=>{throw new Error('shutdown failed');});
 try{await assert.rejects(f.execution.start(),AggregateError);assert.equal(f.execution.status.closed,true);assert.equal(f.execution.status.cleanupErrors.length,1);await assert.rejects(f.execution.stop(),AggregateError);}finally{await f.close().catch(()=>{});}
});

test('pause yields a partial 128-line batch, releases dispatch and resumes each suffix exactly once',async()=>{
 const script=Array.from({length:128},(_,i)=>`G1 X${i}\n`).join(''),seen:number[]=[];
 let entered=Promise.withResolvers<void>(),gate=Promise.withResolvers<void>();
 const f=await fixture(script,async c=>{const n=Number(c.params.X);seen.push(n);if(n===0||n===64){entered.resolve();await gate.promise;}},()=>{},128);
 try{
  const done=f.execution.start();
  for(const boundary of [0,64]){
   await entered.promise;const paused=f.execution.pause();gate.resolve();await paused;
   assert.equal(f.execution.status.phase,'paused');assert.equal(f.execution.status.position,0);assert.equal(f.execution.status.pending,true);
   assert.deepEqual(seen,Array.from({length:boundary+1},(_,i)=>i));
   // Parking/control commands can use the dispatcher after file admission yields.
   await f.dispatch.execute('M110');assert.equal(f.stops,0);
   entered=Promise.withResolvers<void>();gate=Promise.withResolvers<void>();f.execution.resume();
  }
  await done;assert.deepEqual(seen,Array.from({length:128},(_,i)=>i));assert.equal(f.execution.status.position,Buffer.byteLength(script));assert.equal(f.execution.status.phase,'eof');
 }finally{gate.resolve();await f.close();}
});

test('stop from a partial batch never replays or commits its admitted prefix',async()=>{
 const entered=Promise.withResolvers<void>(),gate=Promise.withResolvers<void>();let moves=0;
 const f=await fixture('G1 X1\nG1 X2\n',async()=>{moves++;entered.resolve();await gate.promise;},()=>{},128);
 try{const done=f.execution.start(),rejected=assert.rejects(done);await entered.promise;const paused=f.execution.pause();gate.resolve();await paused;await f.execution.stop();await rejected;assert.equal(moves,1);assert.equal(f.execution.status.position,0);assert.equal(f.execution.status.phase,'stopped');}finally{gate.resolve();await f.close();}
});
for(const periodic of [false,true])test(`held checkpoint pause fences commands and resumes without replay (periodic=${periodic})`,async()=>{
 const entered=Promise.withResolvers<void>(),gate=Promise.withResolvers<void>(),seen:number[]=[];let checks=0,interrupts=0;
 const count=periodic?256:1,script=Array.from({length:count},(_,i)=>`G1 X${i}\n`).join('');
 const f=await fixture(script,c=>{seen.push(Number(c.params.X));},()=>{},128,async()=>{if(++checks===1){entered.resolve();await gate.promise;}});
 try{
  const done=f.execution.start();await entered.promise;const pause=f.execution.pause(async()=>{interrupts++;});assert.equal(interrupts,1);await pause;
  const accepted=seen.length;assert.equal(f.execution.status.checkpointHeld,true);assert.equal(f.execution.status.position,0);await flush();assert.equal(seen.length,accepted);
  let other=false;const queued=f.dispatch.execute('M110').then(()=>{other=true;});await flush();assert.equal(other,false);
  f.execution.resume();gate.resolve();await done;await queued;assert.deepEqual(seen,Array.from({length:count},(_,i)=>i));assert.equal(f.stops,0);
 }finally{gate.resolve();await f.close();}
});
for(const fail of [false,true])test(`checkpoint pause ${fail?'failure aborts dispatch':'stop rejects an uncooperative interrupt without late publication'}`,async()=>{
 const entered=Promise.withResolvers<void>(),interrupt=Promise.withResolvers<void>();
 const f=await fixture('G1 X1\nG1 X2\n',()=>{},()=>{},128,async signal=>{entered.resolve();await new Promise<void>((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});});
 try{
  const done=f.execution.start(),failed=assert.rejects(done);await entered.promise;
  const pause=f.execution.pause(()=>interrupt.promise),rejected=assert.rejects(pause,fail?/interrupt failed/:/file stopped/);
  if(fail)interrupt.reject(new Error('interrupt failed'));else await f.execution.stop(new Error('file stopped'));
  await rejected;await failed;interrupt.resolve();await flush();assert.notEqual(f.execution.status.phase,'paused');assert.equal(f.execution.status.checkpointHeld,false);assert.equal(f.execution.status.position,0);assert.equal(f.stops,1);
 }finally{interrupt.resolve();await f.close();}
});
test('stopping a confirmed checkpoint pause clears actual dispatch ownership',async()=>{
 const entered=Promise.withResolvers<void>();
 const f=await fixture('G1 X1\n',()=>{},()=>{},128,async signal=>{entered.resolve();await new Promise<void>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));});
 try{const done=f.execution.start(),failed=assert.rejects(done);await entered.promise;await f.execution.pause(async()=>{});assert.equal(f.execution.status.checkpointHeld,true);await f.execution.stop();await failed;assert.equal(f.execution.status.checkpointHeld,false);assert.equal(f.execution.status.phase,'stopped');}finally{await f.close();}
});
