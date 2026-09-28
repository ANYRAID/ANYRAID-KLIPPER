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
test('compiled circular mesh persists, reloads and compensates a Delta print',{timeout:120000},async t=>{
 const dir=await mkdtemp('/tmp/circular-mesh-product-'),app=join(dir,'app'),f=await productMachineFixture(dir,true);
 let replacement:Awaited<ReturnType<typeof productTransports>>|undefined,savedMatrix:unknown;
 const timings:number[]=[];let compensatedPosition:unknown;
 try{
  await buildProductHost(app,join(root,'host/tsconfig.product-host.json'),join(root,'host/build'));await symlink(join(root,'host/node_modules'),join(app,'node_modules'),'dir');
  await writeFile(f.config.printerConfig,(await readFile(f.config.printerConfig,'utf8')).replace('homing_retract_dist: 0','homing_retract_dist: .2\nhoming_speed: 40\nsecond_homing_speed: 10')+'\n[probe]\npin: ^aux:PA13'+'\nz_offset: .123456789\nsamples: 2\nsamples_tolerance: 10\nsample_retract_dist: .2\n[bed_mesh]\nmesh_radius: 2\nround_probe_count: 3\nmesh_pps: 0\nhorizontal_move_z: 10\n');
  const gcode=join(dir,'job.gcode'),profile=join(dir,'profile.mjs');await writeFile(gcode,'G1 X0 Y0 Z10 E0.1 F6000\nM400\n');
  await writeFile(profile,`import {open} from 'node:fs/promises';
import {GCodeFileReader} from ${JSON.stringify(pathToFileURL(join(app,'host/src/gcode/file-reader.js')).href)};
import {loadProductMachineProfile} from ${JSON.stringify(pathToFileURL(join(app,'host/src/runtime/product-machine-profile.js')).href)};
export const createProductHostProfile=signal=>loadProductMachineProfile(${JSON.stringify(f.path)},async()=>({stops:new Map(['mcu','aux'].map(id=>[id,async()=>{}])),print:{output(){},async open(){return GCodeFileReader.adopt(await open(${JSON.stringify(gcode)},'r'));},lifecycle:{async prepare(){},async start(){},async finishOutputs(){},async stopOutputs(){}}},server:{information:${JSON.stringify(f.bindings.server.information)},authorize:(_m,_p,c)=>{if(c.request.headers['x-api-key']!=='test')throw Error('Denied');}},async release(){}}),signal);`);
  for(let generation=0;generation<2;generation++){
   if(generation){
    const loaded=await loadKlipperConfiguration(f.config.printerConfig);await replacement?.close();replacement=await productTransports(new ConfigurationReader(loaded,null));
    let text=await readFile(f.config.printerConfig,'utf8');for(const section of ['mcu','mcu aux'])text=text.replace(loaded.original[section].serial,replacement.reader.source.original[section].serial);await writeFile(f.config.printerConfig,text);
   }
   const transport=replacement??f.transport,simulation=simulateDeltaWire(transport),ready=Promise.withResolvers<number>();void ready.promise.catch(()=>{});
   const child=spawn(process.execPath,[join(app,'scripts/product-host.js'),'--profile',profile],{env:{...process.env,PATH:'/no-programs'},stdio:['ignore','pipe','pipe']});let output='',stderr='';
   child.stdout.on('data',chunk=>{output+=chunk;for(let at=output.indexOf('\n');at>=0;at=output.indexOf('\n')){const line=output.slice(0,at);output=output.slice(at+1);try{const v=JSON.parse(line);if(v.event==='ready')ready.resolve(v.address.port);}catch{}}});child.stderr.on('data',chunk=>stderr+=chunk);
   const ended=new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>{ready.reject(Error(stderr));resolve(code);});});
   const timer=setTimeout(()=>{child.kill('SIGKILL');ready.reject(Error('Circular mesh product timeout: '+stderr));},60000);
   try{
    const base='http://127.0.0.1:'+await ready.promise,headers={'x-api-key':'test','content-type':'application/json'};
    const get=async(path:string)=>{const response=await fetch(base+path,{headers});assert.equal(response.status,200,await response.clone().text());return (await response.json() as any).result;};
    const post=async(path:string,body:unknown)=>{const response=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(response.status,200,await response.clone().text());return (await response.json() as any).result;};
    const toolhead=(await get('/printer/objects/query?toolhead')).status.toolhead;assert.equal(toolhead.homed_axes,'');
    if(generation)assert.equal((await get('/printer/objects/query?bed_mesh')).status.bed_mesh.profile_name,'');
    await post('/printer/print/start',{version:1,request_id:'generation-'+generation,file_id:'file',nozzle:200,bed:60,expires_at:Date.now()+30000});
    const deadline=performance.now()+30000;for(;;){const status=await get('/printer/print/status');assert.notEqual(status.state,'failed',JSON.stringify(status));if(status.state==='completed')break;assert(performance.now()<deadline);await new Promise(r=>setTimeout(r,10));}
    assert.deepEqual([...simulation.passes.entries()].sort(),[['a',2],['b',2],['c',2]]);
    const fw=transport.firmware[0],extruder=fw.stepperConfigs.find(s=>s.step_pin===4||s.step_pin==='PA4')!;assert.equal(fw.motion.filter(m=>m.name==='queue_step'&&m.parameters.oid===extruder.oid).reduce((n,m)=>n+Number(m.parameters.count),0),8);
    if(!generation){
     let state:any;for(;;){state=await get('/printer/calibration/bed_mesh');if(state.available)break;assert(performance.now()<deadline);await new Promise(r=>setTimeout(r,10));}
     const start=performance.now(),request={version:1,state_token:state.state_token},receipt=await post('/printer/calibration/bed_mesh',request);timings.push(performance.now()-start);assert.equal(simulation.probeHits,10);assert.deepEqual(await post('/printer/calibration/bed_mesh',request),receipt);assert.equal(simulation.probeHits,10);
     const mesh=(await get('/printer/objects/query?bed_mesh')).status.bed_mesh;assert.equal(mesh.profile_name,'measured');savedMatrix=mesh.probed_matrix;assert.equal((savedMatrix as number[][]).length,3);
     const configuration=await get('/printer/configuration');const saved=await post('/printer/configuration/bed_mesh',{version:1,state_token:configuration.state_token,profile:'retained'});assert.equal(saved.state,'saved');
     await writeFile(gcode,'BED_MESH_PROFILE LOAD=retained\nG1 X-1 Y0 Z10 E0.05 F6000\nG1 X1 Y0 Z10 E0.1 F6000\nM400\n');
     const blocked=await fetch(base+'/printer/print/start',{method:'POST',headers,body:JSON.stringify({version:1,request_id:'must-not-print',file_id:'file',nozzle:200,bed:60,expires_at:Date.now()+30000})});assert.notEqual(blocked.status,200);
    }else{
     const mesh=(await get('/printer/objects/query?bed_mesh')).status.bed_mesh;assert.equal(mesh.profile_name,'retained');assert.deepEqual(mesh.probed_matrix,savedMatrix);assert.equal(simulation.probeHits,0);const position=(await get('/printer/objects/query?toolhead')).status.toolhead.position;compensatedPosition=position;const matrix=savedMatrix as number[][];assert.equal(position[0],1);assert.equal(position[1],0);assert(Math.abs(position[2]-(10+(matrix[1][1]+matrix[1][2])/2))<1e-12);
    }
    child.kill('SIGTERM');assert.equal(await ended,0);
   }finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await ended.catch(()=>{});simulation.close();}
  }
  const journal=await PrintJournal.open({path:f.config.journalPath,deviceId:'printer'});try{for(let i=0;i<2;i++)assert.equal((await journal.get('generation-'+i))?.state,'completed');}finally{await journal.close();}
  const evidence={node:process.version,compiled:true,generations:2,calibrationMs:timings[0],probedMatrix:savedMatrix,compensatedPosition,passed:true,scope:'Compiled CLI with PATH excluding Python, two independent simulated MCU generations, circular calibration, save, explicit profile reload, homing and compensated print. Existing native addons and dependencies reused; excludes clean installation, real hardware and physical precision.'};t.diagnostic(JSON.stringify(evidence));if(process.env.CIRCULAR_MESH_EVIDENCE)await writeFile(process.env.CIRCULAR_MESH_EVIDENCE,JSON.stringify(evidence,null,2)+'\n');
 }finally{await replacement?.close();await f.close();await rm(dir,{recursive:true,force:true});}
});
