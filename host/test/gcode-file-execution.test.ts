import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GCodeFileReader} from '../src/gcode/file-reader.ts';
import {GCodeFileExecution} from '../src/gcode/file-execution.ts';
import {GCodeDispatch,GCodeError,type CommandContext} from '../src/gcode/dispatch.ts';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(script:string,handler:(command:CommandContext)=>void|Promise<void>,onStop:()=>void=()=>{}){
 const directory=await mkdtemp(join(tmpdir(),'file-execution-')),path=join(directory,'file.gcode');await writeFile(path,script);const reader=await GCodeFileReader.adopt(await open(path,'r'),{batchLines:1});let stops=0;
 const dispatch=new GCodeDispatch({output(){},shutdown(){stops++;onStop();}});dispatch.register('G1',handler);dispatch.setReady(true);const execution=new GCodeFileExecution(reader,dispatch);
 return {reader,execution,get stops(){return stops;},async close(){try{await execution.stop();}finally{await rm(directory,{recursive:true,force:true});}}};
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
