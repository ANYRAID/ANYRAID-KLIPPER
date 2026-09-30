import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
import {createNativeProductHostFactory} from '../src/runtime/native-product-machine.ts';
import {runProductHost,type ProductHostFactory,type ProductHostProfile} from '../src/runtime/product-host.ts';
import {ProductHostControl} from '../src/runtime/product-host-control.ts';
import {productMachineFixture} from './helpers/product-machine.ts';
async function until(check:()=>boolean){const end=performance.now()+5000;while(!check()){assert(performance.now()<end,'Process host timeout');await delay(5);}}
const information={connected:false,state:'disconnected' as const,components:[],failedComponents:[],directories:[],warnings:[],version:'process-test',missingRequirements:[]};
async function fixture(failure?:'replacement'|'stop'){
 const root=await mkdtemp(join(tmpdir(),'native-process-')),abort=new AbortController(),control=new ProductHostControl(),ready=Promise.withResolvers<string>();
 let current=await productMachineFixture(root),processOpens=0,processReleases=0,databaseCloses=0,calls=0,key='',db:DatabaseStore|undefined;
 const fixtures=[current],profiles:ProductHostProfile[]=[],addresses:string[]=[];
 const native=createNativeProductHostFactory(current.path,{
  filesRoot:join(root,'files'),metadataRoot:join(root,'metadata'),standardPrint:{nozzle:200,bed:60},
  async createProcess(){
   processOpens++;db=await DatabaseStore.open({path:join(root,'api.db')});const close=db.close.bind(db);db.close=()=>{databaseCloses++;return close();};
   return {server:{information,database:db,authorization:{issuer:'https://process.invalid'}},async release(){processReleases++;if(!db!.status.closed)await db!.close();}};
  },
  async createAdapter(){
   const f=current;
   const stops=new Map([...f.bindings.stops].map(([id,stop])=>[id,async(cause:unknown)=>{await stop(cause);if(failure==='stop'&&id==='mcu')throw new Error('Physical stop failed');}]));
   return {stops,output:f.bindings.print.output,lifecycle:f.bindings.print.lifecycle,async authorizePrintFile(){},release:()=>f.close()};
  }
 });
 const factory:ProductHostFactory=async signal=>{
  if(calls++){assert(profiles.every(p=>p.product.maintenanceGate.status.closed));if(failure==='replacement')throw new Error('Replacement configuration failed');current=await productMachineFixture(root);fixtures.push(current);}
  const profile=await native(signal);profiles.push(profile);return profile;
 };
 Object.defineProperty(factory,'serverLifetime',{value:native.serverLifetime});factory.close=()=>native.close!();
 let terminal=false;
 const running=runProductHost(factory,abort.signal,address=>{const base=`http://127.0.0.1:${address.port}`;addresses.push(base);ready.resolve(base);},control);
 void running.then(()=>{terminal=true;},error=>{terminal=true;ready.reject(error);});
 const available=ready.promise.then(async base=>{key=await (await db!.wrapNamespace('native_authorization',false)).get('api_key') as string;return base;});
 return {root,abort,control,ready:available,running,profiles,fixtures,addresses,get key(){return key;},get db(){return db!;},get counts(){return {processOpens,processReleases,databaseCloses,calls,terminal};},async close(){abort.abort();await running.catch(()=>{});for(const p of profiles)await p.release().catch(()=>{});await native.close!().catch(()=>{});for(const f of fixtures)await f.close();await rm(root,{recursive:true,force:true});}};
}
test('actual host loop retains JWT, database, file lock and identified socket across three device generations',async t=>{
 const f=await fixture();let socket:WebSocket|undefined;const times:number[]=[],fds:number[]=[];
 try{
  const base=await f.ready,events:any[]=[];const user=await (await fetch(base+'/access/user',{method:'POST',headers:{'x-api-key':f.key,'content-type':'application/json'},body:JSON.stringify({username:'operator',password:'test-only-password'})})).json() as any;
  assert(user.result,user.error?.message);const headers={authorization:'Bearer '+user.result.token};
  socket=new WebSocket(base.replace('http:','ws:')+'/websocket',{headers});socket.on('message',bytes=>events.push(JSON.parse(bytes.toString())));await once(socket,'open');
  socket.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'server.connection.identify',params:{client_name:'host-process',version:'1',type:'web',url:'https://process.invalid'}}));await until(()=>events.some(e=>e.id===1));
  const connection=events.find(e=>e.id===1).result.connection_id;
  const form=new FormData();form.append('file',new Blob(['G1 X1\n']),'part.gcode');form.append('file_id','retained');assert.equal((await fetch(base+'/server/files/upload',{method:'POST',headers,body:form})).status,200);
  for(let generation=1;generation<=3;generation++){
   if(generation>1){const start=performance.now();await f.control.reinitialize();times.push(performance.now()-start);}
   assert.equal(f.addresses[generation-1],base);assert.equal(f.db.status.closed,false);assert.equal(socket.readyState,WebSocket.OPEN);assert.equal(f.counts.processOpens,1);assert.equal(f.counts.databaseCloses,0);assert.equal(f.counts.processReleases,0);
   assert.equal((await (await fetch(base+'/server/info',{headers})).json() as any).result.native_host.ready,true);
   assert.equal((await fetch(base+'/server/database/compact',{method:'POST',headers})).status,200);assert.equal(await (await fetch(base+'/server/files/gcodes/retained.gcode',{headers})).text(),'G1 X1\n');
   socket.send(JSON.stringify({jsonrpc:'2.0',id:generation+1,method:'server.websocket.id'}));await until(()=>events.some(e=>e.id===generation+1));assert.equal(events.find(e=>e.id===generation+1).result.websocket_id,connection);
   await assert.rejects(PublishedPrintFiles.open(join(f.root,'files')),/Lock published file directory/);fds.push((await readdir('/proc/self/fd')).length);
  }
  assert(f.fixtures.slice(0,-1).every(g=>g.transport.stops.every(n=>n===1)));assert(fds.at(-1)!<=fds[0]+2);
  f.abort.abort();await f.running;assert.deepEqual(f.counts,{processOpens:1,processReleases:1,databaseCloses:1,calls:3,terminal:true});assert(f.fixtures.every(g=>g.transport.stops.every(n=>n===1)));
  t.diagnostic(JSON.stringify({reinitializeMs:times,readyFileDescriptors:fds,scope:'Three actual host generations with two simulated PTY MCUs each; native JWT and identified WebSocket retained'}));
 }finally{socket?.terminate();await f.close();}
});
for(const failure of ['replacement','stop'] as const)test(`failed ${failure} stays queryable until explicit process shutdown`,async()=>{
 const f=await fixture(failure);
 try{
  const base=await f.ready,headers={'x-api-key':f.key},status=(await (await fetch(base+'/printer/host/status',{headers})).json() as any).result;
  const response=await fetch(base+'/printer/host/reinitialize',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({version:1,request_id:'failed-rebuild',state_token:status.state_token})});assert.equal(response.status,200);assert.equal((await response.json() as any).result.operation.state,'queued');
  await until(()=>f.control.operation('failed-rebuild')?.state==='failed');assert.equal(f.counts.terminal,false);assert.equal(f.db.status.closed,false);assert.equal(f.counts.processReleases,0);assert.equal(f.counts.calls, failure==='stop'?1:2);
  const info=await fetch(base+'/server/info',{headers});assert.equal(info.status,200);const host=(await info.json() as any).result.native_host;assert.equal(host.ready,false);assert.equal(host.hardware_state,failure==='stop'?'failed':'stopped');
  const failed=(await (await fetch(base+'/printer/host/status?request_id=failed-rebuild',{headers})).json() as any).result;assert.equal(failed.operation.state,'failed');assert.equal(failed.available,false);assert.equal(failed.durable,true);
  f.abort.abort();await assert.rejects(f.running,/failed/);assert.equal(f.counts.processReleases,1);assert.equal(f.db.status.closed,true);
 }finally{await f.close();}
});
test('cancelled late adapter releases device before the one process database and file store',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-process-cancel-')),f=await productMachineFixture(root),held=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>(),order:string[]=[],db=await DatabaseStore.open({path:join(root,'api.db')});
 const factory=createNativeProductHostFactory(f.path,{filesRoot:join(root,'files'),metadataRoot:join(root,'metadata'),async createProcess(){return {server:{information,database:db,authorization:{issuer:'https://process.invalid'}},async release(){order.push('process');await db.close();}};},async createAdapter(){entered.resolve();await held.promise;return {stops:f.bindings.stops,output:f.bindings.print.output,lifecycle:f.bindings.print.lifecycle,async authorizePrintFile(){},async release(){order.push('device');await f.close();}};}});
 const opening=factory(new AbortController().signal),rejected=assert.rejects(opening,/closed/);
 try{await entered.promise;const closing=factory.close!();assert.equal(factory.close!(),closing);assert.equal(db.status.closed,false);held.resolve();await rejected;await closing;assert.deepEqual(order,['device','process']);assert.equal(db.status.closed,true);const files=await PublishedPrintFiles.open(join(root,'files'));await files.close();}
 finally{held.resolve();await opening.catch(()=>{});await factory.close!();await f.close();await db.close();await rm(root,{recursive:true,force:true});}
});
test('invalid process authorization rejects before device acquisition and final cleanup releases the file lock',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-process-invalid-')),f=await productMachineFixture(root);let devices=0,releases=0;
 const factory=createNativeProductHostFactory(f.path,{filesRoot:join(root,'files'),metadataRoot:join(root,'metadata'),async createProcess(){return {server:{information,authorizeNotification(){}} as any,async release(){releases++;}};},async createAdapter(){devices++;throw Error('Unexpected device acquisition');}});
 try{await assert.rejects(factory(new AbortController().signal),/authorization callbacks/);assert.equal(devices,0);await factory.close!();assert.equal(releases,1);const files=await PublishedPrintFiles.open(join(root,'files'));await files.close();}
 finally{await factory.close!();await f.close();await rm(root,{recursive:true,force:true});}
});
test('process-mode adapter cannot hide a second server owner in its device resources',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-process-device-')),f=await productMachineFixture(root);let devicesReleased=0,processReleased=0;
 const factory=createNativeProductHostFactory(f.path,{filesRoot:join(root,'files'),metadataRoot:join(root,'metadata'),async createProcess(){return {server:{information,authorize(){},authorizeNotification(){}},async release(){processReleased++;}};},async createAdapter(){return {stops:f.bindings.stops,output:f.bindings.print.output,lifecycle:f.bindings.print.lifecycle,async authorizePrintFile(){},server:{information,authorize(){}},async release(){devicesReleased++;}};}});
 try{await assert.rejects(factory(new AbortController().signal),/only device/);assert.equal(devicesReleased,1);await factory.close!();assert.equal(processReleased,1);}
 finally{await factory.close!();await f.close();await rm(root,{recursive:true,force:true});}
});
