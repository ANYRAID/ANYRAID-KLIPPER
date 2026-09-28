import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {buildProductHost} from '../scripts/build-product-host.ts';
import {productMachineFixture} from '../test/helpers/product-machine.ts';
import {productTransports} from '../test/helpers/product-transports.ts';
import {simulateDeltaWire} from '../test/helpers/delta-wire-simulation.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {loadKlipperConfiguration} from '../src/config/klipper-files.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
const root=fileURLToPath(new URL('../..',import.meta.url));
for(const bltouch of [false,true])test('compiled Delta calibration persists, reloads unhomed and prints with new geometry; bltouch='+bltouch,{timeout:120000},async t=>{
 const dir=await mkdtemp('/tmp/delta-calibrated-product-'),app=join(dir,'app'),f=await productMachineFixture(dir,true);
 let replacement:Awaited<ReturnType<typeof productTransports>>|undefined,candidate:any;
 const timings:number[]=[];
 try{
  await buildProductHost(app,join(root,'host/tsconfig.product-host.json'),join(root,'host/build'));await symlink(join(root,'host/node_modules'),join(app,'node_modules'),'dir');
  await writeFile(f.config.printerConfig,(await readFile(f.config.printerConfig,'utf8')).replace('homing_retract_dist: 0','homing_retract_dist: .2\nhoming_speed: 40\nsecond_homing_speed: 10')+(bltouch?'\n[bltouch]\nsensor_pin: ^aux:PA13\ncontrol_pin: PA14\npin_move_time: .3':'\n[probe]\npin: ^aux:PA13')+'\nz_offset: .123456789\nsamples: 2\nsamples_tolerance: 10\nsample_retract_dist: .2\n[delta_calibrate]\nradius: 2\nhorizontal_move_z: 10\n');
  const gcode=join(dir,'job.gcode'),profile=join(dir,'profile.mjs');await writeFile(gcode,'G1 X0 Y0 Z10 E0.1 F6000\nM400\n');
  await writeFile(profile,`import {open} from 'node:fs/promises';
import {GCodeFileReader} from ${JSON.stringify(pathToFileURL(join(app,'host/src/gcode/file-reader.js')).href)};
import {loadProductMachineProfile} from ${JSON.stringify(pathToFileURL(join(app,'host/src/runtime/product-machine-profile.js')).href)};
export const createProductHostProfile=signal=>loadProductMachineProfile(${JSON.stringify(f.path)},async()=>({stops:new Map(['mcu','aux'].map(id=>[id,async()=>{}])),print:{output(){},async open(){return GCodeFileReader.adopt(await open(${JSON.stringify(gcode)},'r'));},lifecycle:{async prepare(){},async start(){},async finishOutputs(){},async stopOutputs(){}}},server:{information:${JSON.stringify(f.bindings.server.information)},authorize:(_m,_p,c)=>{if(c.request.headers['x-api-key']!=='test')throw Error('Denied');}},async release(){}}),signal);`);
  for(let generation=0;generation<5;generation++){
   if(generation){
    const loaded=await loadKlipperConfiguration(f.config.printerConfig);await replacement?.close();replacement=await productTransports(new ConfigurationReader(loaded,null));
    let text=await readFile(f.config.printerConfig,'utf8');for(const section of ['mcu','mcu aux'])text=text.replace(loaded.original[section].serial,replacement.reader.source.original[section].serial);if(generation===2)text=text.replace(/\n\[(?:probe|bltouch)\][\s\S]*?(?=\n\[)/,'');await writeFile(f.config.printerConfig,text);
   }
   const transport=replacement??f.transport,simulation=simulateDeltaWire(transport,{bltouch:bltouch&&generation<2}),ready=Promise.withResolvers<number>();void ready.promise.catch(()=>{});
   const child=spawn(process.execPath,[join(app,'scripts/product-host.js'),'--profile',profile],{env:{...process.env,PATH:'/no-programs'},stdio:['ignore','pipe','pipe']});let output='',stderr='';
   child.stdout.on('data',chunk=>{output+=chunk;for(let at=output.indexOf('\n');at>=0;at=output.indexOf('\n')){const line=output.slice(0,at);output=output.slice(at+1);try{const v=JSON.parse(line);if(v.event==='ready')ready.resolve(v.address.port);}catch{}}});child.stderr.on('data',chunk=>stderr+=chunk);
   const ended=new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>{ready.reject(Error(stderr));resolve(code);});});
   const timer=setTimeout(()=>{child.kill('SIGKILL');ready.reject(Error('Delta calibration product timeout: '+stderr));},60000);
   try{
    const base='http://127.0.0.1:'+await ready.promise,headers={'x-api-key':'test','content-type':'application/json'};
    const get=async(path:string)=>{const response=await fetch(base+path,{headers});assert.equal(response.status,200,await response.clone().text());return (await response.json() as any).result;};
    const post=async(path:string,body:unknown)=>{const response=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(response.status,200,await response.clone().text());return (await response.json() as any).result;};
    const toolhead=(await get('/printer/objects/query?toolhead')).status.toolhead;assert.equal(toolhead.homed_axes,'');
    if(generation){assert.equal(toolhead.axis_maximum[2],Math.min(...candidate.geometry.endstops));assert.notEqual(toolhead.axis_maximum[2],300);assert.equal((await get('/printer/calibration/delta')).candidate,null);}
    await post('/printer/print/start',{version:1,request_id:'generation-'+generation,file_id:'file',nozzle:200,bed:60,expires_at:Date.now()+30000});
    const deadline=performance.now()+30000;for(;;){const status=await get('/printer/print/status');assert.notEqual(status.state,'failed',JSON.stringify(status));if(status.state==='completed')break;assert(performance.now()<deadline);await new Promise(r=>setTimeout(r,10));}
    assert.deepEqual([...simulation.passes.entries()].sort(),[['a',2],['b',2],['c',2]]);
    const fw=transport.firmware[0],extruder=fw.stepperConfigs.find(s=>s.step_pin===4||s.step_pin==='PA4')!;assert.equal(fw.motion.filter(m=>m.name==='queue_step'&&m.parameters.oid===extruder.oid).reduce((n,m)=>n+Number(m.parameters.count),0),8);
    if(!generation){
     let state:any;for(;;){state=await get('/printer/calibration/delta');if(state.available)break;assert(performance.now()<deadline);await new Promise(r=>setTimeout(r,10));}
     const start=performance.now(),request={version:1,state_token:state.state_token,action:'calibrate'},receipt=await post('/printer/calibration/delta',request);timings.push(performance.now()-start);candidate=receipt.candidate;assert.equal(simulation.probeHits,14);assert.deepEqual(await post('/printer/calibration/delta',request),receipt);assert.equal(simulation.probeHits,14);
     if(bltouch){const pwm=transport.firmware[0].outputs.filter(o=>o.name==='queue_digital_out_generation');assert(pwm.some(o=>Number(o.parameters.on_ticks)===650));assert.equal(Number(pwm.at(-1)!.parameters.on_ticks),0);}
     const save={version:1,state_token:receipt.state_token,action:'save'},saved=await post('/printer/calibration/delta',save);assert(saved.restart_required);assert.equal(saved.available,false);assert.deepEqual(await post('/printer/calibration/delta',save),saved);
     assert.equal((await get('/printer/objects/query?toolhead')).status.toolhead.axis_maximum[2],300);
     const blocked=await fetch(base+'/printer/print/start',{method:'POST',headers,body:JSON.stringify({version:1,request_id:'must-not-print',file_id:'file',nozzle:200,bed:60,expires_at:Date.now()+30000})});assert.notEqual(blocked.status,200);
     const source=await loadKlipperConfiguration(f.config.printerConfig);assert.equal(Number(source.original.printer.delta_radius),candidate.geometry.radius);
    }
    if(generation===1){
     let state:any;for(;;){state=await get('/printer/calibration/delta');if(state.available)break;assert(performance.now()<deadline);await new Promise(r=>setTimeout(r,10));}
     const measurements={scale:1,centerWidths:[4,5,6],outerWidths:[4,5,6,7,8,9],centerDistances:[69,71,70,69,71,70].map(v=>v+.0065),outerDistances:[69,70,71,72,73,74].map(v=>v+.0065)};
     const request={version:1,state_token:state.state_token,action:'extend',measurements},before=transport.firmware.map(fw=>fw.motion.length),start=performance.now(),receipt=await post('/printer/calibration/delta',request);timings.push(performance.now()-start);
     const beforeGeometry=candidate.geometry;candidate=receipt.candidate;assert(candidate.geometry.arms.some((v:number,i:number)=>Math.abs(v-beforeGeometry.arms[i])>1e-4));assert.equal(candidate.distance_residuals.length,12);assert.equal(simulation.probeHits,0);assert.deepEqual(transport.firmware.map(fw=>fw.motion.length),before);assert.deepEqual(await post('/printer/calibration/delta',request),receipt);
     const save={version:1,state_token:receipt.state_token,action:'save'},saved=await post('/printer/calibration/delta',save);assert(saved.restart_required);assert.deepEqual(await post('/printer/calibration/delta',save),saved);
     const source=await loadKlipperConfiguration(f.config.printerConfig);assert.equal(Object.keys(source.original.delta_calibrate).filter(k=>/^distance[0-9]+$/.test(k)).length,12);
    }
    if(generation===2){
     let state:any;for(;;){state=await get('/printer/calibration/delta/manual');if(state.available)break;assert(performance.now()<deadline);await new Promise(r=>setTimeout(r,10));}
     assert.equal((await get('/printer/calibration/delta')).automatic,false);
     const start=performance.now(),manualPath='/printer/calibration/delta/manual';
     const action=async(action:string,extra:object={})=>{const current=await get(manualPath);return post(manualPath,{version:1,state_token:current.state_token,action,...extra});};
     await action('start');for(let i=0;i<7;i++){await action('adjust',{delta:-.2});const result=await action('accept');assert.equal(result.accepted.length,i+1);}
     assert.equal((await get(manualPath)).state,'completed');const result=await get('/printer/calibration/delta');candidate=result.candidate;assert.equal(result.state,'candidate');assert.equal(simulation.probeHits,0);
     await post('/printer/calibration/delta',{version:1,state_token:result.state_token,action:'save'});timings.push(performance.now()-start);
    }
    if(generation===3){
     let state:any;for(;;){state=await get('/printer/calibration/delta');if(state.available)break;assert(performance.now()<deadline);await new Promise(r=>setTimeout(r,10));}
     const before=transport.firmware.map(fw=>fw.motion.length),start=performance.now(),request={version:1,state_token:state.state_token,action:'height',height:10},recorded=await post('/printer/calibration/delta',request);timings.push(performance.now()-start);
     assert.equal(recorded.manual_count,1);assert.equal(recorded.candidate,null);assert.deepEqual(await post('/printer/calibration/delta',request),recorded);assert.deepEqual(transport.firmware.map(fw=>fw.motion.length),before);
     const measurements={scale:1,centerWidths:[4,5,6],outerWidths:[4,5,6,7,8,9],centerDistances:[69,71,70,69,71,70].map(v=>v+.0065),outerDistances:[69,70,71,72,73,74].map(v=>v+.0065)};
     const fitted=await post('/printer/calibration/delta',{version:1,state_token:recorded.state_token,action:'extend',measurements});candidate=fitted.candidate;assert.equal(candidate.height_residuals.length,8);
     await post('/printer/calibration/delta',{version:1,state_token:fitted.state_token,action:'save'});const loaded=await loadKlipperConfiguration(f.config.printerConfig);assert.equal(Number(loaded.original.delta_calibrate.manual_height0),10);
    }
    child.kill('SIGTERM');assert.equal(await ended,0);
   }finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await ended.catch(()=>{});simulation.close();}
  }
  const journal=await PrintJournal.open({path:f.config.journalPath,deviceId:'printer'});try{for(let i=0;i<5;i++)assert.equal((await journal.get('generation-'+i))?.state,'completed');}finally{await journal.close();}
  const evidence={node:process.version,compiled:true,bltouch,generations:5,calibrationMs:timings[0],extensionMs:timings[1],manualMs:timings[2],heightCaptureMs:timings[3],finalError:candidate.final_error,geometry:candidate.geometry,passed:true,scope:'Compiled CLI, five independent simulated MCU generations, automatic, extended and probeless manual calibration with persisted observations, actual config reload and homing plus eight extruder steps per print. Existing native addons/dependencies reused; excludes real hardware, clean installation and stable performance acceptance.'};t.diagnostic(JSON.stringify(evidence));if(process.env.DELTA_CALIBRATION_EVIDENCE)await writeFile(bltouch?process.env.DELTA_CALIBRATION_EVIDENCE.replace(/\.json$/,'-bltouch.json'):process.env.DELTA_CALIBRATION_EVIDENCE,JSON.stringify(evidence,null,2)+'\n');
 }finally{await replacement?.close();await f.close();await rm(dir,{recursive:true,force:true});}
});
