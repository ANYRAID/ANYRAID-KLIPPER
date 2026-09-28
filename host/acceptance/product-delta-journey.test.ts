import {simulateDeltaWire} from '../test/helpers/delta-wire-simulation.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile,readFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {buildProductHost} from '../scripts/build-product-host.ts';
import {productMachineFixture} from '../test/helpers/product-machine.ts';
const root=fileURLToPath(new URL('../..',import.meta.url));
// Compiled runtime integration with existing local native/dependency artifacts.
// This does not certify clean installation or physical stop adapters.
test('Delta source and compiled CLI complete heated file extrusion and persist completion',async t=>{
 const probeSamples:{compiled:boolean;run:number;wallMs:number;readyWaitMs:number}[]=[];
 const dir=await mkdtemp(join(tmpdir(),'delta-startup-')),app=join(dir,'app'),samples:{compiled:boolean;run:number;printMs:number}[]=[];
 try{
  await buildProductHost(app,join(root,'host/tsconfig.product-host.json'),join(root,'host/build'));
  await symlink(join(root,'host/node_modules'),join(app,'node_modules'),'dir');
  for(let run=0;run<4;run++)for(const compiled of run%2?[true,false]:[false,true]){
   const work=join(dir,`${run}-${compiled}`);await mkdir(work);const f=await productMachineFixture(work,true),trace=join(work,'trace.jsonl'),profile=join(work,'profile.mjs');
   const simulation=simulateDeltaWire(f.transport);
   await writeFile(f.config.printerConfig,(await readFile(f.config.printerConfig,'utf8')).replace('homing_retract_dist: 0','homing_retract_dist: .2\nhoming_speed: 40\nsecond_homing_speed: 10')+'\n[probe]\npin: ^aux:PA13\nz_offset: .123456789\nsamples: 2\nsamples_tolerance: 10\nsample_retract_dist: .2\n');
   const gcode=join(work,'job.gcode');await writeFile(gcode,'G1 X0 Y0 Z299 E0.1 F600\nM400\n');
   const runtime=compiled?join(app,'host/src/runtime/product-machine-profile.js'):join(root,'host/src/runtime/product-machine-profile.ts');
   await writeFile(profile,`import {appendFile,open} from 'node:fs/promises';
import {GCodeFileReader} from ${JSON.stringify(pathToFileURL(compiled?join(app,'host/src/gcode/file-reader.js'):join(root,'host/src/gcode/file-reader.ts')).href)};
import {loadProductMachineProfile} from ${JSON.stringify(pathToFileURL(runtime).href)};
const record=e=>appendFile(${JSON.stringify(trace)},JSON.stringify(e)+'\\n');
export const createProductHostProfile=signal=>loadProductMachineProfile(${JSON.stringify(f.path)},async()=>({
 stops:new Map(['mcu','aux'].map(id=>[id,async()=>record({stop:id})])),
 print:{output(){},async open(id){if(id!=='file')throw Error('Unknown file');return GCodeFileReader.adopt(await open(${JSON.stringify(gcode)},'r'),{onClosed:()=>{void record({fileClosed:true});}});},lifecycle:{async prepare(){},async start(){},async finishOutputs(){},async stopOutputs(){}}},
 server:{information:${JSON.stringify(f.bindings.server.information)},authorize:(_m,_p,c)=>{if(c.request.headers['x-api-key']!=='test')throw Error('Denied');}},
 async release(){await record({released:true});}
}),signal);
`);
   const child=spawn(process.execPath,[compiled?join(app,'scripts/product-host.js'):join(root,'scripts/product-host.ts'),'--profile',profile],{env:{...process.env,PATH:'/no-programs'},stdio:['ignore','pipe','pipe']});
   const ready=Promise.withResolvers<number>();void ready.promise.catch(()=>{});let pending='',stderr='';
   child.stdout.on('data',chunk=>{pending+=chunk;for(let i=pending.indexOf('\n');i>=0;i=pending.indexOf('\n')){const line=pending.slice(0,i);pending=pending.slice(i+1);try{const v=JSON.parse(line);if(v.event==='ready')ready.resolve(v.address.port);}catch{}}});child.stderr.on('data',chunk=>{stderr+=chunk;});
   const ended=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.on('error',reject);child.on('exit',(code,signal)=>{ready.reject(Error(stderr));resolve({code,signal});});});
   const timer=setTimeout(()=>{child.kill('SIGKILL');ready.reject(Error('Delta startup timeout: '+stderr));},30000);
   try{
    const port=await ready.promise;
    const response=await fetch(`http://127.0.0.1:${port}/printer/objects/query?toolhead`,{headers:{'x-api-key':'test'}});assert.equal(response.status,200);
    const status=(await response.json() as any).result.status.toolhead;assert.equal(status.homed_axes,'');assert.deepEqual(status.axis_maximum,[100,100,300,0]);
    assert(f.transport.firmware.every(m=>m.motion.length===0));
    const start=performance.now(),started=await fetch(`http://127.0.0.1:${port}/printer/print/start`,{method:'POST',headers:{'x-api-key':'test','content-type':'application/json'},body:JSON.stringify({version:1,request_id:'delta-job',file_id:'file',nozzle:200,bed:60,expires_at:Date.now()+15000})});assert.equal(started.status,200,await started.text());
    let state:any;const deadline=performance.now()+15000;
    do{const response=await fetch(`http://127.0.0.1:${port}/printer/print/status`,{headers:{'x-api-key':'test'}});assert.equal(response.status,200);state=(await response.json() as any).result;assert.notEqual(state.state,'failed',JSON.stringify(state));if(state.state==='completed')break;assert(performance.now()<deadline,JSON.stringify(state));await new Promise(r=>setTimeout(r,10));}while(true);
    samples.push({compiled,run,printMs:performance.now()-start});assert.deepEqual([...simulation.passes.entries()].sort(),[['a',2],['b',2],['c',2]]);
    const after=await (await fetch(`http://127.0.0.1:${port}/printer/objects/query?toolhead&extruder&heater_bed`,{headers:{'x-api-key':'test'}})).json() as any;
    assert.deepEqual(after.result.status.toolhead.position,[0,0,299,.1]);assert.equal(after.result.status.extruder.target,0);assert.equal(after.result.status.heater_bed.target,0);
    const fw=f.transport.firmware[0],extruder=fw.stepperConfigs.find(s=>s.step_pin===4||s.step_pin==='PA4')!;assert(extruder);assert.equal(fw.motion.filter(m=>m.name==='queue_step'&&m.parameters.oid===extruder.oid).reduce((n,m)=>n+Number(m.parameters.count),0),8);
    const probeURL=`http://127.0.0.1:${port}/printer/calibration/probe`,probeDeadline=performance.now()+5000;let probeState:any;
    do{probeState=(await (await fetch(probeURL,{headers:{'x-api-key':'test'}})).json() as any).result;if(probeState.available)break;assert(performance.now()<probeDeadline,JSON.stringify({run,compiled,probeState,after:after.result,state}));await new Promise(r=>setTimeout(r,10));}while(true);
    const probeStart=performance.now(),body=JSON.stringify({version:1,state_token:probeState.state_token}),probeReply=await fetch(probeURL,{method:'POST',headers:{'x-api-key':'test','content-type':'application/json'},body});assert.equal(probeReply.status,200,await probeReply.clone().text());
    const receipt=(await probeReply.json() as any).result;probeSamples.push({compiled,run,wallMs:performance.now()-probeStart,readyWaitMs:probeStart-(probeDeadline-5000)});assert.equal(receipt.result.attempts,2);assert.equal(receipt.result.samples.length,2);assert.equal(simulation.probeHits,2);assert.equal(receipt.result.position[3],.1);assert(receipt.result.position.every(Number.isFinite));assert.equal(receipt.result.bed_position[2],receipt.result.position[2]-.123456789);
    const replay=await fetch(probeURL,{method:'POST',headers:{'x-api-key':'test','content-type':'application/json'},body});assert.equal(replay.status,200);assert.deepEqual((await replay.json() as any).result,receipt);assert.equal(simulation.probeHits,2);
    assert.equal(fw.motion.filter(m=>m.name==='queue_step'&&m.parameters.oid===extruder.oid).reduce((n,m)=>n+Number(m.parameters.count),0),8);
    child.kill('SIGTERM');assert.deepEqual(await ended,{code:0,signal:null});
    const events=(await readFile(trace,'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.deepEqual(events.filter(e=>e.stop).map(e=>e.stop).sort(),['aux','mcu']);assert.deepEqual(events.at(-1),{released:true});assert.equal(events.filter(e=>e.fileClosed).length,1);const journal=await PrintJournal.open({path:f.config.journalPath,deviceId:'printer'});try{assert.equal((await journal.get('delta-job'))?.state,'completed');}finally{await journal.close();}await assert.rejects(fetch(`http://127.0.0.1:${port}/server/info`));
   }finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await ended.catch(()=>{});simulation.close();await f.close();}
  }
  const median=(compiled:boolean)=>samples.filter(s=>s.compiled===compiled&&s.run>0).map(s=>s.printMs).sort((a,b)=>a-b)[1];
  const sourceMs=median(false),compiledMs=median(true),maximumMs=sourceMs*1.3+50;
  const probeMedian=(compiled:boolean)=>probeSamples.filter(s=>s.compiled===compiled&&s.run>0).map(s=>s.wallMs).sort((a,b)=>a-b)[1];
  const probeSourceMs=probeMedian(false),probeCompiledMs=probeMedian(true),probeMaximumMs=probeSourceMs*1.3+50;
  const result={node:process.version,warmupsPerMode:1,samplesPerMode:3,sourceMs,compiledMs,maximumMs,passed:compiledMs<=maximumMs&&probeCompiledMs<=probeMaximumMs,probeSourceMs,probeCompiledMs,probeMaximumMs,samples,probeSamples,scope:'Delta source/compiled CLI heated short file print over two simulated PTY MCUs; wire-only endstop and ADC model, exact eight extruder steps, file close and durable completion after shutdown. After normal G28 and printing, completes two probe samples with retract and token replay, without seeding homing authority. Local native addons/dependencies reused. Excludes physical hardware and long-print throughput.'};
  t.diagnostic('DeltaJourneyBenchmark '+JSON.stringify(result));if(process.env.DELTA_JOURNEY_EVIDENCE)await writeFile(process.env.DELTA_JOURNEY_EVIDENCE,JSON.stringify(result,null,2)+'\n');assert(result.passed);
 }finally{await rm(dir,{recursive:true,force:true});}
});
