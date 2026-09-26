import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runProductHost} from '../src/runtime/product-host.ts';
import {parseProductHostArgs,runProductHostCLI} from '../src/runtime/product-host-cli.ts';
import {productHostFixture} from './helpers/product-host-profile.ts';
const signal=()=>new AbortController().signal;
test('CLI help and invalid paths never load a machine profile',async()=>{
 let output='';await runProductHostCLI(['--help'],signal(),text=>{output+=text;});assert.match(output,/--profile/);
 for(const args of [[],['--profile','relative.ts'],['--profile','https://example.test/a.ts'],['--profile','/tmp/machine.py'],['--help','extra']])assert.throws(()=>parseProductHostArgs(args));
 const dir=await mkdtemp(join(tmpdir(),'host-module-'));try{const file=join(dir,'empty.mjs');await writeFile(file,'export const unrelated = true;');await assert.rejects(runProductHostCLI(['--profile',file],signal(),()=>{}),/must export/);}finally{await rm(dir,{recursive:true,force:true});}
});
test('host closes a profile returned after cancellation without opening UARTs',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'host-late-')),f=await productHostFixture(dir),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),abort=new AbortController();
 let done=false;const running=runProductHost(async()=>{entered.resolve();await release.promise;return f.profile;},abort.signal,()=>assert.fail('late ready')).finally(()=>{done=true;});
 try{await entered.promise;abort.abort(new Error('cancel profile'));await Promise.resolve();assert.equal(done,false);assert.equal(f.released,false);release.resolve();await running;assert(f.released);assert.deepEqual(f.transport.stops,[0,0]);assert(f.transport.firmware.every(f=>f.outputs.length===0));}finally{release.resolve();await running.catch(()=>{});await f.profile.release();await rm(dir,{recursive:true,force:true});}
});
for(const failedStop of [false,true])test(`runtime hardware fault retains authenticated status until shutdown (stop failure=${failedStop})`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'host-fault-')),f=await productHostFixture(dir),abort=new AbortController(),ready=Promise.withResolvers<string>();
 if(failedStop){const policy=f.profile.policies.get('mcu')!,stop=policy.stopDevice;policy.stopDevice=async cause=>{await stop(cause);throw new Error('Independent physical stop failed');};}
 let settled=false;const running=runProductHost(async()=>f.profile,abort.signal,address=>ready.resolve(`http://127.0.0.1:${address.port}`)).finally(()=>{settled=true;});void running.catch(error=>ready.reject(error));
 try{
  const url=await ready.promise;await f.transport.firmware[0].close();
  const deadline=performance.now()+5000;let status:any;
  for(;;){const response=await fetch(url+'/server/info',{headers:{'x-api-key':'test'}});assert.equal(response.status,200);status=(await response.json() as any).result.native_host;if(['stopped','failed'].includes(status.group_state))break;assert(performance.now()<deadline);await new Promise(resolve=>setTimeout(resolve,5));}
  assert.equal(status.ready,false);assert.equal(status.homed_axes,'');assert.equal(f.released,false);assert.equal(settled,false);assert.deepEqual(f.transport.stops,[1,1]);
  const denied=await fetch(url+'/printer/print/status');assert.equal(denied.status,401);await denied.arrayBuffer();
  const response=await fetch(url+'/printer/print/status',{headers:{'x-api-key':'test'}});assert.equal(response.status,200);assert.equal((await response.json() as any).result.state,'failed');
  const started=await fetch(url+'/printer/print/start',{method:'POST',headers:{'x-api-key':'test','content-type':'application/json'},body:JSON.stringify({version:1,request_id:'after-fault',file_id:'file',nozzle:0,bed:0,expires_at:Date.now()+60000})});assert.equal(started.status,409);await started.arrayBuffer();assert(f.transport.firmware.every(f=>f.motion.length===0));
  assert.equal(status.group_state,failedStop?'failed':'stopped');abort.abort();if(failedStop)await assert.rejects(running);else await running;assert(f.released);await assert.rejects(fetch(url+'/printer/print/status'));
 }finally{abort.abort();await running.catch(()=>{});await f.profile.release();await rm(dir,{recursive:true,force:true});}
});
for(const termination of ['SIGINT','SIGTERM'] as const)test(`executable host owns authenticated HTTP and graceful ${termination} shutdown`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'host-process-')),script=fileURLToPath(new URL('../../scripts/product-host.ts',import.meta.url)),profile=fileURLToPath(new URL('./helpers/product-host-profile.ts',import.meta.url));
 const child=spawn(process.execPath,[script,'--profile',profile],{env:{...process.env,ANYRAID_TEST_PROFILE_DIR:dir},stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';const ready=Promise.withResolvers<{address:{port:number}}>();void ready.promise.catch(()=>{});
 child.stdout.on('data',chunk=>{stdout+=chunk;for(const line of stdout.split('\n'))try{const value=JSON.parse(line);if(value.event==='ready')ready.resolve(value);}catch{}});child.stderr.on('data',chunk=>{stderr+=chunk;});
 const ended=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.on('error',reject);child.on('exit',(code,signal)=>{ready.reject(new Error(`Host exited before ready: ${stderr}`));resolve({code,signal});});});
 const timer=setTimeout(()=>{child.kill('SIGKILL');ready.reject(new Error(`Host test timeout: ${stderr}`));},15000);
 try{
  const {address}=await ready.promise,url=`http://127.0.0.1:${address.port}/printer/print/status`;
  const denied=await fetch(url);assert.equal(denied.status,401);await denied.arrayBuffer();const accepted=await fetch(url,{headers:{'x-api-key':'test'}});assert.equal(accepted.status,200);assert.equal((await accepted.json() as any).result.state,'idle');
  child.kill(termination);assert.deepEqual(await ended,{code:0,signal:null});assert.deepEqual(JSON.parse(await readFile(join(dir,'closed.json'),'utf8')),{stops:[1,1],motion:[0,0]});await assert.rejects(fetch(url));
 }finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await ended.catch(()=>{});await rm(dir,{recursive:true,force:true});}
});
test('ready callback failure still closes hardware and reports dependency cleanup failure',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'host-errors-')),f=await productHostFixture(dir),release=f.profile.release;
 f.profile.release=async()=>{await release();throw new Error('dependency release failed');};
 try{
  await assert.rejects(runProductHost(async()=>f.profile,signal(),()=>{throw new Error('ready notification failed');}),error=>error instanceof AggregateError&&error.errors.some(e=>e.message==='ready notification failed')&&error.errors.some(e=>e.message==='dependency release failed'));
  assert(f.released);assert.deepEqual(f.transport.stops,[1,1]);
 }finally{await release();await rm(dir,{recursive:true,force:true});}
});
