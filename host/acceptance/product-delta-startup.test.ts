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
test('Delta declarative source and compiled CLI start with matching geometry and retire both MCUs',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'delta-startup-')),app=join(dir,'app'),samples:{compiled:boolean;run:number;readyMs:number}[]=[];
 try{
  await buildProductHost(app,join(root,'host/tsconfig.product-host.json'),join(root,'host/build'));
  await symlink(join(root,'host/node_modules'),join(app,'node_modules'),'dir');
  for(let run=0;run<4;run++)for(const compiled of run%2?[true,false]:[false,true]){
   const work=join(dir,`${run}-${compiled}`);await mkdir(work);const f=await productMachineFixture(work,true),trace=join(work,'trace.jsonl'),profile=join(work,'profile.mjs');
   const runtime=compiled?join(app,'host/src/runtime/product-machine-profile.js'):join(root,'host/src/runtime/product-machine-profile.ts');
   await writeFile(profile,`import {appendFile} from 'node:fs/promises';
import {loadProductMachineProfile} from ${JSON.stringify(pathToFileURL(runtime).href)};
const record=e=>appendFile(${JSON.stringify(trace)},JSON.stringify(e)+'\\n');
export const createProductHostProfile=signal=>loadProductMachineProfile(${JSON.stringify(f.path)},async()=>({
 stops:new Map(['mcu','aux'].map(id=>[id,async()=>record({stop:id})])),
 print:{output(){},async open(){throw Error('Unexpected print');},lifecycle:{async prepare(){},async start(){},async finishOutputs(){},async stopOutputs(){}}},
 server:{information:${JSON.stringify(f.bindings.server.information)},authorize:(_m,_p,c)=>{if(c.request.headers['x-api-key']!=='test')throw Error('Denied');}},
 async release(){await record({released:true});}
}),signal);
`);
   const start=performance.now(),child=spawn(process.execPath,[compiled?join(app,'scripts/product-host.js'):join(root,'scripts/product-host.ts'),'--profile',profile],{env:{...process.env,PATH:'/no-programs'},stdio:['ignore','pipe','pipe']});
   const ready=Promise.withResolvers<number>();void ready.promise.catch(()=>{});let pending='',stderr='';
   child.stdout.on('data',chunk=>{pending+=chunk;for(let i=pending.indexOf('\n');i>=0;i=pending.indexOf('\n')){const line=pending.slice(0,i);pending=pending.slice(i+1);try{const v=JSON.parse(line);if(v.event==='ready')ready.resolve(v.address.port);}catch{}}});child.stderr.on('data',chunk=>{stderr+=chunk;});
   const ended=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.on('error',reject);child.on('exit',(code,signal)=>{ready.reject(Error(stderr));resolve({code,signal});});});
   const timer=setTimeout(()=>{child.kill('SIGKILL');ready.reject(Error('Delta startup timeout: '+stderr));},15000);
   try{
    const port=await ready.promise;samples.push({compiled,run,readyMs:performance.now()-start});
    const response=await fetch(`http://127.0.0.1:${port}/printer/objects/query?toolhead`,{headers:{'x-api-key':'test'}});assert.equal(response.status,200);
    const status=(await response.json() as any).result.status.toolhead;assert.equal(status.homed_axes,'');assert.deepEqual(status.axis_maximum,[100,100,300,0]);
    assert(f.transport.firmware.every(m=>m.motion.length===0));child.kill('SIGTERM');assert.deepEqual(await ended,{code:0,signal:null});
    const events=(await readFile(trace,'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.deepEqual(events.filter(e=>e.stop).map(e=>e.stop).sort(),['aux','mcu']);assert.deepEqual(events.at(-1),{released:true});await assert.rejects(fetch(`http://127.0.0.1:${port}/server/info`));
   }finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await ended.catch(()=>{});await f.close();}
  }
  const median=(compiled:boolean)=>samples.filter(s=>s.compiled===compiled&&s.run>0).map(s=>s.readyMs).sort((a,b)=>a-b)[1];
  const sourceMs=median(false),compiledMs=median(true),maximumMs=sourceMs*1.3+50;
  const result={node:process.version,warmupsPerMode:1,samplesPerMode:3,sourceMs,compiledMs,maximumMs,passed:compiledMs<=maximumMs,samples,scope:'Delta declarative CLI process startup to ready over two simulated PTY MCUs; includes geometry status and graceful shutdown verification. Local native addons and dependencies reused. No print throughput or physical hardware acceptance.'};
  t.diagnostic('DeltaStartupBenchmark '+JSON.stringify(result));if(process.env.DELTA_STARTUP_EVIDENCE)await writeFile(process.env.DELTA_STARTUP_EVIDENCE,JSON.stringify(result,null,2)+'\n');assert(result.passed);
 }finally{await rm(dir,{recursive:true,force:true});}
});
