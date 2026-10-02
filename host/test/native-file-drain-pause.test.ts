import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {nativeLinearFixture} from './helpers/native-linear-port.ts';
import {NativeLinearGCode} from '../src/runtime/native-linear-gcode.ts';
import {GCodeFileReader} from '../src/gcode/file-reader.ts';
import {GCodeFileExecution} from '../src/gcode/file-execution.ts';
const rails=[51,0,0].map(endstop=>({endstop,positiveDirection:false,speed:10,retractDistance:0,retractSpeed:10,secondSpeed:5,endstops:['test']}));
test('file M400 pauses before its queued endpoint and resumes every retained command once',async()=>{
 const t=await nativeLinearFixture(),g=new NativeLinearGCode(t.port,t.kinematics,rails,()=>{}),s=new AbortController().signal,dir=await mkdtemp(join(tmpdir(),'m400-pause-'));
 let file:GCodeFileExecution|undefined,done:Promise<void>|undefined,interrupts=0;
 try{
  t.kinematics.markHomed([0,1,2]);await t.port.forcePosition([50,0,0,2],s);g.coordinates.resetPosition();g.enable();
  const path=join(dir,'job.gcode');await writeFile(path,'G1 X51 F30\nM400\nG1 X52 F600\n');file=new GCodeFileExecution(await GCodeFileReader.adopt(await open(path,'r'),{batchLines:3}),g.dispatch);done=file.start();void done.catch(()=>{});
  const deadline=performance.now()+3000;while(t.port.status.phase!=='drain'){assert(performance.now()<deadline,'M400 drain did not start');await new Promise(resolve=>setImmediate(resolve));}
  await file.pause(async()=>{interrupts++;await t.port.pause(s);});assert.equal(interrupts,1,'M400 must expose its drain as a file checkpoint');assert.equal(file.status.checkpointHeld,true);assert(t.port.status.pausePosition![0]<51);assert.equal(file.objectStatus.file_position,0);
  await t.port.resumeStream(s);file.resume();await done;await t.port.drain(s);assert.equal(file.status.phase,'eof');assert.deepEqual(g.coordinates.state.position,[52,0,0,2]);assert.deepEqual(t.port.homingPosition(),[52,0,0,2]);assert.equal(t.f.fw.motion.filter(m=>m.name==='queue_step'&&m.parameters.oid===3).reduce((sum,m)=>sum+Number(m.parameters.count),0),200);assert.equal(t.f.stops,0);
 }finally{await file?.stop();await g.close();await done?.catch(()=>{});await t.close();await rm(dir,{recursive:true,force:true});}
});

for(const cancel of [false,true])test(`pause joins the final drain after streaming has finished (cancel=${cancel})`,{timeout:10000},async()=>{
 const t=await nativeLinearFixture(),controller=new AbortController(),s=controller.signal,entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 const original=t.generation.source.drain.bind(t.generation.source);let hold=true,draining:Promise<void>|undefined,pausing:ReturnType<typeof t.port.pause>|undefined;
 t.generation.source.drain=async(...args)=>{if(hold){hold=false;entered.resolve();await release.promise;}return original(...args);};
 try{
  t.kinematics.markHomed([0,1,2]);t.port.move([51,0,0,2],10);draining=t.port.drain(s);void draining.catch(()=>{});await entered.promise;
  assert.equal(t.port.status.phase,'drain');assert.equal(t.port.status.stream.busy,false);
  pausing=t.port.pause(s);void pausing.catch(()=>{});if(cancel){controller.abort(new Error('cancel tail pause'));release.resolve();await assert.rejects(pausing,/cancel tail pause/);await assert.rejects(draining);assert.equal(t.port.status.failed,true);return;}release.resolve();await draining;const stopped=await pausing;assert.deepEqual(stopped.position,[51,0,0,2]);assert.equal(t.f.stops,0);await t.port.resumeStream(s);assert.equal(t.port.status.failed,false);
 }finally{release.resolve();await Promise.allSettled([draining,pausing]);await t.close();}
});
