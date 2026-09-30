import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {request} from 'node:http';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {createNativeProductHostFactory} from '../src/runtime/native-product-machine.ts';
import {runProductHost,type ProductHostProfile} from '../src/runtime/product-host.ts';
import type {ProductMachineBindings} from '../src/runtime/product-machine-profile.ts';
import {MCUConfigurationFault} from '../src/protocol/mcu-config.ts';
import {ProductHostControl} from '../src/runtime/product-host-control.ts';
import {productMachineFixture} from './helpers/product-machine.ts';
async function until(check:()=>boolean){const end=performance.now()+10000;while(!check()){assert(performance.now()<end,'Restart timeout');await delay(5);}}
async function fixture(stopFailure=false,hooks:{prepare?:ProductMachineBindings['print']['lifecycle']['prepare'];replacement?:()=>Promise<void>;firmwareReset?:'ack'|'starting'}={}){
 const root=await mkdtemp(join(tmpdir(),'native-restart-')),f=await productMachineFixture(root,false,hooks.firmwareReset),control=new ProductHostControl(),abort=new AbortController(),ready=Promise.withResolvers<string>();
 const profiles:ProductHostProfile[]=[],reasons:string[]=[],addresses:string[]=[];let db:DatabaseStore|undefined,key='',releases=0;
 const native=createNativeProductHostFactory(f.path,{filesRoot:join(root,'files'),metadataRoot:join(root,'metadata'),standardPrint:{nozzle:200,bed:60},
  async createProcess(){db=await DatabaseStore.open({path:join(root,'api.db')});return {server:{information:f.bindings.server.information,database:db,authorization:{issuer:'https://restart.invalid'}},async release(){if(!db!.status.closed)await db!.close();await f.close();}};},
  async createAdapter(_config,_signal,_gate,_process,reload){reasons.push(reload?.reason??'missing');if(reasons.length>1)await hooks.replacement?.();return {stops:new Map([...f.bindings.stops].map(([id,stop])=>[id,async(cause:unknown)=>{await stop(cause);if(stopFailure&&id==='mcu')throw new Error('Physical stop not confirmed');}])),output:f.bindings.print.output,lifecycle:reasons.length===1&&hooks.prepare?{...f.bindings.print.lifecycle,prepare:hooks.prepare}:f.bindings.print.lifecycle,async authorizePrintFile(){},async release(){releases++;}};}
 });
 const factory=Object.assign(async(signal:AbortSignal,context?:Parameters<typeof native>[1])=>{const p=await native(signal,context);profiles.push(p);return p;},{serverLifetime:native.serverLifetime,bootstrap:native.bootstrap,close:()=>native.close!()});
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
for(const index of [0,1])test(`RESTART refuses MCU ${index} CRC drift without rewriting existing configuration`,async t=>{
 const f=await fixture(false,{firmwareReset:'ack'});try{
  const config=await readFile(f.f.config.printerConfig,'utf8'),needle=index===0?'step_pin: STEP':'pin: aux:PA0',changed=config.replace(needle,index===0?'step_pin: !STEP':'pin: !aux:PA0');assert.notEqual(changed,config);
  const firmware=f.f.transport.firmware,status=firmware.map(m=>m.configuration),traffic=firmware.map(m=>m.configurationTraffic),counts=firmware.map(m=>m.stepperConfigs.length);assert(firmware.every(m=>m.dictionary.commandFormats.includes('reset')));
  await writeFile(f.f.config.printerConfig,changed);const receipts:string[]=[];
  for(let attempt=0;attempt<2;attempt++){
   await f.restart();await until(()=>f.control.status.restart_operation?.state==='failed'&&!f.control.status.busy);receipts.push(f.control.status.restart_operation!.request_id);
   const host=(await f.get('/server/info')).native_host;assert.equal(host.ready,false);assert.equal(host.startup_failure,'mcu_configuration_mismatch');assert.equal(host.firmware_restart_required,true);assert.equal(host.hardware_state,'stopped');assert.equal(f.control.status.restart_available,true);assert.equal(f.addresses.length,1);assert.deepEqual(firmware.map(m=>m.configuration),status);assert.deepEqual(firmware.map(m=>m.configurationTraffic.writes),traffic.map(m=>m.writes));assert.deepEqual(firmware.map(m=>m.configurationTraffic.finalizations),traffic.map(m=>m.finalizations));assert(firmware.every(m=>m.configurationTraffic.resets===0));await f.get('/server/files/list');await f.get('/server/history/list');
  }
  assert.notEqual(receipts[0],receipts[1]);for(const id of receipts)assert.equal(f.control.operation(id)?.state,'failed');
  await writeFile(f.f.config.printerConfig,config);await f.restart();await until(()=>f.control.status.restart_operation?.state==='succeeded');assert.equal(f.addresses.length,2);assert.equal((await f.get('/server/info')).native_host.ready,true);assert.equal((await f.get('/server/info')).native_host.firmware_restart_required,undefined);assert.deepEqual(firmware.map(m=>m.configuration),status);assert.deepEqual(firmware.map(m=>m.stepperConfigs.length),counts);assert(firmware.every(m=>m.configurationTraffic.resets===0));f.abort.abort();await f.running;t.diagnostic(JSON.stringify({fault:'crc_mismatch',mcu:index,ordinaryFailures:receipts.length,restoredOriginalConfiguration:true,configurationTraffic:firmware.map(m=>m.configurationTraffic)}));
 }finally{await f.close();}
});
for(const index of [0,1])test(`latched shutdown on MCU ${index} stays queryable and ordinary HTTP/RPC RESTART cannot cure it`,async t=>{
 const f=await fixture(false,{firmwareReset:'ack'});let socket:WebSocket|undefined;try{
  const firmware=f.f.transport.firmware,status=firmware.map(m=>m.configuration),writes=firmware.map(m=>m.configurationTraffic.writes),events:any[]=[];
  socket=new WebSocket(f.base.replace('http:','ws:')+'/websocket',{headers:{'x-api-key':f.key}});socket.on('message',b=>events.push(JSON.parse(b.toString())));await once(socket,'open');socket.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'server.connection.identify',params:{client_name:'fault-restart',version:'1',type:'web',url:'https://restart.invalid'}}));await until(()=>events.some(e=>e.id===1));
  firmware[index].emit('shutdown',{clock:firmware[index].currentClock()>>>0,static_string_id:'Timer too close'});await until(()=>f.f.transport.stops.every(n=>n>0));await until(()=>events.some(e=>e.method==='notify_klippy_shutdown'));assert.equal((await f.get('/server/info')).native_host.ready,false);assert.equal(firmware[index].configuration.shutdown,true);
  const failures:string[]=[];
  for(let attempt=0;attempt<2;attempt++){
   if(attempt===0)await f.restart();else{socket.send(JSON.stringify({jsonrpc:'2.0',id:2,method:'printer.restart'}));await until(()=>events.some(e=>e.id===2));assert.equal(events.find(e=>e.id===2).result,'ok');}
   await until(()=>f.control.status.restart_operation?.state==='failed'&&!f.control.status.busy);failures.push(f.control.status.restart_operation!.request_id);
   const host=(await f.get('/server/info')).native_host;assert.equal(host.ready,false);assert.equal(host.startup_failure,'mcu_shutdown');assert.equal(host.firmware_restart_required,true);assert.equal(f.addresses.length,1);assert.equal(socket.readyState,WebSocket.OPEN);assert(!events.some(e=>e.method==='notify_klippy_ready'));assert.deepEqual(firmware.map(m=>m.configuration.crc),status.map(m=>m.crc));assert.equal(firmware[index].configuration.shutdown,true);assert.deepEqual(firmware.map(m=>m.configurationTraffic.writes),writes);assert(firmware.every(m=>m.configurationTraffic.resets===0));await f.get('/server/files/list');await f.get('/server/history/list');
   const print=await fetch(f.base+'/printer/print/start',{method:'POST',headers:{'x-api-key':f.key,'content-type':'application/json'},body:'{"filename":"never.gcode"}'});assert.equal(print.status,503);await print.arrayBuffer();
  }
  assert.notEqual(failures[0],failures[1]);for(const id of failures)assert.equal(f.control.operation(id)?.state,'failed');assert(firmware[index].configurationTraffic.reads>=4);f.abort.abort();await assert.rejects(f.running,error=>error instanceof AggregateError&&error.errors.length===2&&error.errors.every(cause=>cause instanceof MCUConfigurationFault&&cause.code==='shutdown'));t.diagnostic(JSON.stringify({fault:'latched_shutdown',mcu:index,ordinaryFailures:failures.length,configurationTraffic:firmware.map(m=>m.configurationTraffic)}));
 }finally{socket?.terminate();await f.close();}
});
test('diagnostic text cannot spoof MCU recovery classification',async()=>{
 const f=await fixture(false,{replacement:async()=>{throw Error('MCU configuration CRC mismatch; reset required');}});try{await f.restart();await until(()=>f.control.status.restart_operation?.state==='failed');const host=(await f.get('/server/info')).native_host;assert.equal(host.startup_failure,'device_startup_failed');assert.equal(host.firmware_restart_required,undefined);assert.equal(f.control.status.restart_available,true);}finally{await f.close();}
});
test('unconfirmed cleanup takes precedence over a nested typed MCU failure',async()=>{
 const f=await fixture(false,{replacement:async()=>{throw new AggregateError([new MCUConfigurationFault('crc_mismatch'),Error('Physical cleanup unconfirmed')],'Device startup and cleanup failed');}});try{await f.restart();await until(()=>f.control.status.restart_operation?.state==='failed');const host=(await f.get('/server/info')).native_host;assert.equal(host.startup_failure,'cleanup_unconfirmed');assert.equal(host.firmware_restart_required,undefined);assert.equal(host.hardware_state,'failed');assert.equal(f.control.status.restart_available,false);}finally{await f.close();}
});
