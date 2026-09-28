import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {buildProductHost} from '../scripts/build-product-host.ts';
import {productMachineFixture} from '../test/helpers/product-machine.ts';
import {simulateDeltaWire} from '../test/helpers/delta-wire-simulation.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
const root=fileURLToPath(new URL('../..',import.meta.url));
for(const change of ['same','other','modified'])test('compiled adaptive calibration binds subsequent print file; change='+change,{timeout:120000},async t=>{
 const dir=await mkdtemp('/tmp/adaptive-mesh-product-'),app=join(dir,'app'),f=await productMachineFixture(dir,true);
 let savedMatrix:unknown;
 const timings:number[]=[];let compensatedPosition:unknown;let successivePrintMs:number|undefined;
 try{
  await buildProductHost(app,join(root,'host/tsconfig.product-host.json'),join(root,'host/build'));await symlink(join(root,'host/node_modules'),join(app,'node_modules'),'dir');
  await writeFile(f.config.printerConfig,(await readFile(f.config.printerConfig,'utf8')).replace('homing_retract_dist: 0','homing_retract_dist: .2\nhoming_speed: 40\nsecond_homing_speed: 10')+'\n[probe]\npin: ^aux:PA13'+'\nz_offset: .123456789\nsamples: 2\nsamples_tolerance: 10\nsample_retract_dist: .2\n[bed_mesh]\nmesh_radius: 20\nround_probe_count: 5\nmesh_pps: 0\nhorizontal_move_z: 10\n'+'\n[exclude_object]\n');
  const gcode=join(dir,'job.gcode'),profile=join(dir,'profile.mjs');await writeFile(gcode,'EXCLUDE_OBJECT_DEFINE NAME=part POLYGON=[[-1,-1],[1,-1],[1,1],[-1,1]]\nG92 E0\nG1 X0 Y0 Z10 E0.1 F6000\nM400\n');const other=join(dir,'other.gcode');await writeFile(other,await readFile(gcode));
  await writeFile(profile,`import {open} from 'node:fs/promises';
import {GCodeFileReader} from ${JSON.stringify(pathToFileURL(join(app,'host/src/gcode/file-reader.js')).href)};
import {loadProductMachineProfile} from ${JSON.stringify(pathToFileURL(join(app,'host/src/runtime/product-machine-profile.js')).href)};
export const createProductHostProfile=signal=>loadProductMachineProfile(${JSON.stringify(f.path)},async()=>({stops:new Map(['mcu','aux'].map(id=>[id,async()=>{}])),print:{output(){},async open(id){if(!['file','other'].includes(id))throw Error('Unknown file');return GCodeFileReader.adopt(await open(id==='file'?${JSON.stringify(gcode)}:${JSON.stringify(other)},'r'));},lifecycle:{async prepare(){},async start(){},async finishOutputs(){},async stopOutputs(){}}},server:{information:${JSON.stringify(f.bindings.server.information)},authorize:(_m,_p,c)=>{if(c.request.headers['x-api-key']!=='test')throw Error('Denied');}},async release(){}}),signal);`);
  {
   const transport=f.transport,simulation=simulateDeltaWire(transport),ready=Promise.withResolvers<number>();void ready.promise.catch(()=>{});
   const child=spawn(process.execPath,[join(app,'scripts/product-host.js'),'--profile',profile],{env:{...process.env,PATH:'/no-programs'},stdio:['ignore','pipe','pipe']});let output='',stderr='';
   child.stdout.on('data',chunk=>{output+=chunk;for(let at=output.indexOf('\n');at>=0;at=output.indexOf('\n')){const line=output.slice(0,at);output=output.slice(at+1);try{const v=JSON.parse(line);if(v.event==='ready')ready.resolve(v.address.port);}catch{}}});child.stderr.on('data',chunk=>stderr+=chunk);
   const ended=new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>{ready.reject(Error(stderr));resolve(code);});});
   const timer=setTimeout(()=>{child.kill('SIGKILL');ready.reject(Error('Circular mesh product timeout: '+stderr));},60000);
   try{
    const base='http://127.0.0.1:'+await ready.promise,headers={'x-api-key':'test','content-type':'application/json'};
    const get=async(path:string)=>{const response=await fetch(base+path,{headers});assert.equal(response.status,200,await response.clone().text());return (await response.json() as any).result;};
    const post=async(path:string,body:unknown)=>{const response=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(response.status,200,(await response.clone().text())+' '+stderr);return (await response.json() as any).result;};
    const toolhead=(await get('/printer/objects/query?toolhead')).status.toolhead;assert.equal(toolhead.homed_axes,'');
    const home=await get('/printer/calibration/home');await post('/printer/calibration/home',{version:1,state_token:home.state_token});
    assert.deepEqual([...simulation.passes.entries()].sort(),[['a',2],['b',2],['c',2]]);const deadline=performance.now()+30000;
    const path='/printer/calibration/bed_mesh/adaptive';let state:any;for(;;){state=await get(path);if(state.available)break;assert(performance.now()<deadline);await new Promise(r=>setTimeout(r,10));}
    const request={version:1,state_token:state.state_token,file_id:'file'},start=performance.now(),receipt=await post(path,request);timings.push(performance.now()-start);assert.equal(receipt.adapted,true);assert.equal(receipt.contact_count,5);assert.deepEqual(receipt.probe_count,[3,3]);assert.equal(simulation.probeHits,10);assert.deepEqual(await post(path,request),receipt);assert.equal(simulation.probeHits,10);
    const mesh=(await get('/printer/objects/query?bed_mesh')).status.bed_mesh;assert.equal(mesh.profile_name,'adaptive');savedMatrix=mesh.probed_matrix;
    const configuration=await get('/printer/configuration'),save=await fetch(base+'/printer/configuration/bed_mesh',{method:'POST',headers,body:JSON.stringify({version:1,state_token:configuration.state_token,profile:'must-not-persist'})});assert.equal(save.status,409);
    const before=transport.firmware.map(fw=>fw.motion.filter(m=>m.name==='queue_step').length);
    if(change==='modified')await writeFile(gcode,(await readFile(gcode,'utf8'))+'; source changed\n');
    const response=await fetch(base+'/printer/print/start',{method:'POST',headers,body:JSON.stringify({version:1,request_id:'adapted-print',file_id:change==='other'?'other':'file',nozzle:200,bed:60,expires_at:Date.now()+30000})});assert.equal(response.status,200,await response.clone().text());
    const finish=performance.now()+30000;for(;;){const status=await get('/printer/print/status');if(status.state===(change==='same'?'completed':'failed'))break;assert.notEqual(status.state,change==='same'?'failed':'completed');assert(performance.now()<finish);await new Promise(r=>setTimeout(r,10));}
    if(change==='same'){
     compensatedPosition=(await get('/printer/objects/query?toolhead')).status.toolhead.position;assert(Math.abs((compensatedPosition as number[])[2]-(10+(savedMatrix as number[][])[1][1]))<1e-12);
     const fw=transport.firmware[0],extruder=fw.stepperConfigs.find(s=>s.step_pin===4||s.step_pin==='PA4')!;assert.equal(fw.motion.filter(m=>m.name==='queue_step'&&m.parameters.oid===extruder.oid).reduce((n,m)=>n+Number(m.parameters.count),0),8);
    }else assert.deepEqual(transport.firmware.map(fw=>fw.motion.filter(m=>m.name==='queue_step').length),before);
    const settled=performance.now()+10000;for(;;){const result=await get('/printer/print/status?request_id=adapted-print');if(result.record?.state===(change==='same'?'completed':'failed')&&!result.current.safe_stop_pending&&!result.current.pending_device_actions)break;assert(performance.now()<settled,JSON.stringify(result));await new Promise(r=>setTimeout(r,10));}
    if(change==='same'){
     const current=await get('/printer/print/status'),resetBody={request_id:'adapted-print',state_token:current.state_token};
     await post('/printer/print/reset',resetBody);assert.equal((await get('/printer/print/status')).state,'idle');
     const nextStart=performance.now();await post('/printer/print/start',{version:1,request_id:'adapted-print-next',file_id:'file',nozzle:200,bed:60,expires_at:Date.now()+30000});
     const nextDeadline=performance.now()+30000;for(;;){const result=await get('/printer/print/status?request_id=adapted-print-next');assert.notEqual(result.current.state,'failed',JSON.stringify(result));if(result.record?.state==='completed'&&!result.current.safe_stop_pending&&!result.current.pending_device_actions)break;assert(performance.now()<nextDeadline,JSON.stringify(result));await new Promise(r=>setTimeout(r,10));}
     successivePrintMs=performance.now()-nextStart;assert.equal(simulation.probeHits,10);
     const nextMesh=(await get('/printer/objects/query?bed_mesh')).status.bed_mesh;assert.equal(nextMesh.profile_name,'adaptive');assert.deepEqual(nextMesh.probed_matrix,savedMatrix);
     const nextPosition=(await get('/printer/objects/query?toolhead')).status.toolhead.position;assert(Math.abs(nextPosition[2]-(10+(savedMatrix as number[][])[1][1]))<1e-12);
     const fw=transport.firmware[0],extruder=fw.stepperConfigs.find(s=>s.step_pin===4||s.step_pin==='PA4')!;assert.equal(fw.motion.filter(m=>m.name==='queue_step'&&m.parameters.oid===extruder.oid).reduce((n,m)=>n+Number(m.parameters.count),0),16);
    }
    child.kill('SIGTERM');assert.equal(await ended,0);
   }finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await ended.catch(()=>{});simulation.close();}
  }
  const journal=await PrintJournal.open({path:f.config.journalPath,deviceId:'printer'});try{assert.equal((await journal.get('adapted-print'))?.state,change==='same'?'completed':'interrupted');if(change==='same')assert.equal((await journal.get('adapted-print-next'))?.state,'completed');}finally{await journal.close();}
  const evidence={node:process.version,compiled:true,change,successivePrintMs,completedJobs:change==='same'?2:0,calibrationMs:timings[0],originalContacts:13,adaptedContacts:5,probedMatrix:savedMatrix,compensatedPosition:compensatedPosition??null,passed:true,scope:'Compiled simulated-MCU case: same means two compensated prints complete across controlled reset with no additional probes and eight extrusion steps per job; other/modified means admitted request fails before new steps. Each case includes adaptive calibration and persistence rejection. Existing dependencies reused; excludes clean installation and physical precision.'};t.diagnostic(JSON.stringify(evidence));if(process.env.ADAPTIVE_MESH_EVIDENCE)await writeFile(process.env.ADAPTIVE_MESH_EVIDENCE.replace(/\.json$/,'-'+change+'.json'),JSON.stringify(evidence,null,2)+'\n');
 }finally{await f.close();await rm(dir,{recursive:true,force:true});}
});
