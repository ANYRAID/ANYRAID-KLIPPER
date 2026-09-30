import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {request} from 'node:http';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {createNativeProductHostFactory} from '../src/runtime/native-product-machine.ts';
import {runProductHost,type ProductHostProfile} from '../src/runtime/product-host.ts';
import type {ProductMachineBindings} from '../src/runtime/product-machine-profile.ts';
import {ProductHostControl} from '../src/runtime/product-host-control.ts';
import {productMachineFixture} from './helpers/product-machine.ts';
async function until(check:()=>boolean){const end=performance.now()+10000;while(!check()){assert(performance.now()<end,'Restart timeout');await delay(5);}}
async function fixture(stopFailure=false,hooks:{prepare?:ProductMachineBindings['print']['lifecycle']['prepare'];replacement?:()=>Promise<void>}={}){
 const root=await mkdtemp(join(tmpdir(),'native-restart-')),f=await productMachineFixture(root),control=new ProductHostControl(),abort=new AbortController(),ready=Promise.withResolvers<string>();
 const profiles:ProductHostProfile[]=[],reasons:string[]=[],addresses:string[]=[];let db:DatabaseStore|undefined,key='',releases=0;
 const native=createNativeProductHostFactory(f.path,{filesRoot:join(root,'files'),metadataRoot:join(root,'metadata'),standardPrint:{nozzle:200,bed:60},
  async createProcess(){db=await DatabaseStore.open({path:join(root,'api.db')});return {server:{information:f.bindings.server.information,database:db,authorization:{issuer:'https://restart.invalid'}},async release(){if(!db!.status.closed)await db!.close();await f.close();}};},
  async createAdapter(_config,_signal,_gate,_process,reload){reasons.push(reload?.reason??'missing');if(reasons.length>1)await hooks.replacement?.();return {stops:new Map([...f.bindings.stops].map(([id,stop])=>[id,async(cause:unknown)=>{await stop(cause);if(stopFailure&&id==='mcu')throw new Error('Physical stop not confirmed');}])),output:f.bindings.print.output,lifecycle:reasons.length===1&&hooks.prepare?{...f.bindings.print.lifecycle,prepare:hooks.prepare}:f.bindings.print.lifecycle,async authorizePrintFile(){},async release(){releases++;}};}
 });
 const factory=Object.assign(async(signal:AbortSignal,context?:Parameters<typeof native>[1])=>{const p=await native(signal,context);profiles.push(p);return p;},{serverLifetime:native.serverLifetime,close:()=>native.close!()});
 const running=runProductHost(factory,abort.signal,address=>{const base=`http://127.0.0.1:${address.port}`;addresses.push(base);ready.resolve(base);},control);void running.catch(ready.reject);
 const base=await ready.promise;key=await (await db!.wrapNamespace('native_authorization',false)).get('api_key') as string;
 const get=async(path:string)=>{const response=await fetch(base+path,{headers:{'x-api-key':key}});assert.equal(response.status,200,path);return (await response.json() as any).result;};
 const restart=async()=>{const response=await fetch(base+'/printer/restart',{method:'POST',headers:{'x-api-key':key}});assert.equal(response.status,200);assert.equal((await response.json() as any).result,'ok');};
 return {f,root,control,abort,running,profiles,reasons,addresses,base,get,restart,get key(){return key;},get releases(){return releases;},async close(){abort.abort();await running.catch(()=>{});await native.close!().catch(()=>{});await f.close();await rm(root,{recursive:true,force:true});}};
}
test('HTTP RESTART keeps the same MCU firmware and config, then explicitly recovers a bad replacement',async t=>{
 const f=await fixture();try{
  const counts=f.f.transport.firmware.map(m=>m.stepperConfigs.length),journal=f.profiles[0].product.journal,files=f.profiles[0].options.server.nativeProcessFiles!;
  const cfg=await readFile(f.f.config.printerConfig,'utf8');
  for(let generation=2;generation<=3;generation++){await f.restart();await until(()=>f.control.status.restart_operation?.state==='succeeded');assert.equal(f.addresses.length,generation);assert(f.addresses.every(b=>b===f.base));assert.deepEqual(f.f.transport.firmware.map(m=>m.stepperConfigs.length),counts);assert.equal(f.profiles.at(-1)!.product.journal,journal);assert.equal(f.profiles.at(-1)!.options.server.nativeProcessFiles,files);assert.equal((await f.get('/server/info')).native_host.ready,true);}
  await writeFile(f.f.config.printerConfig,'[printer]\nkinematics: invalid\n');await f.restart();await until(()=>f.control.status.restart_operation?.state==='failed');const failed=f.control.status.restart_operation!;
  assert.equal(f.control.status.restart_available,true);assert.equal(f.control.status.available,false);assert.equal(f.addresses.length,3);assert.equal((await f.get('/server/info')).native_host.ready,false);assert.equal((await f.get('/server/history/list')).count,0);await f.get('/server/files/list');
  await delay(30);assert.equal(f.addresses.length,3);await writeFile(f.f.config.printerConfig,cfg);await f.restart();await until(()=>f.control.status.restart_operation?.state==='succeeded');assert.equal(f.addresses.length,4);assert.equal(f.control.operation(failed.request_id)?.state,'failed');assert.deepEqual(f.reasons,['initial','restart','restart','restart']);assert.deepEqual(f.f.transport.firmware.map(m=>m.stepperConfigs.length),counts);assert.equal(f.f.transport.firmware.flatMap(m=>m.outputs).filter(o=>o.name==='reset').length,0);
  f.abort.abort();await f.running;assert.equal(f.releases,4);t.diagnostic('Four ready host generations, same two PTY MCU firmware models and unchanged stepper configuration; explicit recovery after invalid configuration, no automatic retry/reset/replay.');
 }finally{await f.close();}
});
test('standard restart stays unavailable after unconfirmed physical stop',async()=>{
 const f=await fixture(true);try{await f.restart();await until(()=>f.control.status.restart_operation?.state==='failed');assert.equal(f.control.status.restart_available,false);assert.equal(f.addresses.length,1);assert.equal((await f.get('/server/info')).native_host.ready,false);assert.equal((await fetch(f.base+'/printer/restart',{method:'POST',headers:{'x-api-key':f.key}})).status,503);f.abort.abort();await assert.rejects(f.running,/stop|cleanup/i);}finally{await f.close();}
});
test('RESTART cancels a preparing job but waits for its ignored cancellation before attaching',async()=>{
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();const f=await fixture(false,{prepare:async(_job,signal)=>{entered.resolve();await release.promise;signal.throwIfAborted();}});let starting:Promise<Response>|undefined;
 try{
  const headers={'x-api-key':f.key},form=new FormData();form.append('file',new Blob(['G1 X1\n']),'held.gcode');form.append('file_id','held');assert.equal((await fetch(f.base+'/server/files/upload',{method:'POST',headers,body:form})).status,200);
  starting=fetch(f.base+'/printer/print/start',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({filename:'held.gcode'})});await entered.promise;await f.restart();await until(()=>f.f.transport.stops.every(n=>n===1));await delay(25);assert.equal(f.addresses.length,1);assert.equal(f.control.status.restart_operation?.state,'running');
  release.resolve();await starting;await until(()=>f.control.status.restart_operation?.state==='succeeded');assert.equal(f.addresses.length,2);const jobs=(await f.profiles[1].product.journal!.scan()).records;assert.equal(jobs.length,1);assert.equal(jobs[0].state,'cancelled');assert.equal(f.f.transport.firmware.flatMap(m=>m.motion).length,0);assert.equal((await f.get('/server/info')).native_host.ready,true);
 }finally{release.resolve();await starting?.catch(()=>{});await f.close();}
});
test('late standard HTTP body cannot restart a newer device generation',async()=>{
 const f=await fixture();let pending:ReturnType<typeof request>|undefined;try{
  const outcome=Promise.withResolvers<number>();pending=request(f.base+'/printer/restart',{method:'POST',headers:{'x-api-key':f.key,'content-type':'application/json','transfer-encoding':'chunked'}},res=>{res.resume();res.on('end',()=>outcome.resolve(res.statusCode!));});pending.on('error',outcome.reject);pending.write('{');await delay(25);
  await f.restart();await until(()=>f.control.status.restart_operation?.state==='succeeded');pending.end('}');assert.equal(await outcome.promise,503);await delay(25);assert.equal(f.addresses.length,2);
 }finally{pending?.destroy();await f.close();}
});
test('shutdown during replacement prevents attachment and records an unsuccessful restart',async()=>{
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();const f=await fixture(false,{replacement:async()=>{entered.resolve();await release.promise;}});
 try{await f.restart();await entered.promise;assert.equal(f.addresses.length,1);f.abort.abort();release.resolve();await f.running;assert.equal(f.addresses.length,1);assert.equal(f.control.status.restart_operation?.state,'failed');assert.equal(f.releases,2);}finally{release.resolve();await f.close();}
});
test('partial replacement cleanup failure cannot reuse a stopped snapshot to admit another restart',async()=>{
 const f=await fixture(false,{replacement:async()=>{throw new AggregateError([new Error('Adapter startup failed'),new Error('New device cleanup failed')],'Native machine assembly and cleanup failed');}});
 try{await f.restart();await until(()=>f.control.status.restart_operation?.state==='failed');assert.equal(f.control.status.restart_available,false);assert.equal(f.addresses.length,1);assert.equal((await f.get('/server/info')).native_host.ready,false);assert.equal((await fetch(f.base+'/printer/restart',{method:'POST',headers:{'x-api-key':f.key}})).status,503);f.abort.abort();await assert.rejects(f.running,/cleanup/);}finally{await f.close();}
});
