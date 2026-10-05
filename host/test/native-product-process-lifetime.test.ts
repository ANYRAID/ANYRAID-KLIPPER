import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {request} from 'node:http';
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
async function fixture(failure?:'replacement'|'stop',holdReplacement=false){
 const root=await mkdtemp(join(tmpdir(),'native-process-')),abort=new AbortController(),control=new ProductHostControl(),ready=Promise.withResolvers<string>();
 let current=await productMachineFixture(root),processOpens=0,processReleases=0,databaseCloses=0,calls=0,key='',db:DatabaseStore|undefined;
 const fixtures=[current],profiles:ProductHostProfile[]=[],addresses:string[]=[],detached=Promise.withResolvers<void>(),replacement=Promise.withResolvers<void>();
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
  if(calls++){assert(profiles.every(p=>p.product.maintenanceGate.status.closed));detached.resolve();if(holdReplacement)await replacement.promise;if(failure==='replacement')throw new Error('Replacement configuration failed');current=await productMachineFixture(root);fixtures.push(current);}
  const profile=await native(signal);profiles.push(profile);return profile;
 };
 Object.defineProperty(factory,'serverLifetime',{value:native.serverLifetime});factory.close=()=>native.close!();
 let terminal=false;
 const running=runProductHost(factory,abort.signal,address=>{const base=`http://127.0.0.1:${address.port}`;addresses.push(base);ready.resolve(base);},control);
 void running.then(()=>{terminal=true;},error=>{terminal=true;ready.reject(error);});
 const available=ready.promise.then(async base=>{key=await (await db!.wrapNamespace('native_authorization',false)).get('api_key') as string;return base;});
 return {root,abort,control,ready:available,running,profiles,fixtures,addresses,detached:detached.promise,replacement,get key(){return key;},get db(){return db!;},get counts(){return {processOpens,processReleases,databaseCloses,calls,terminal};},async close(){replacement.resolve();abort.abort();await running.catch(()=>{});for(const p of profiles)await p.release().catch(()=>{});await native.close!().catch(()=>{});for(const f of fixtures)await f.close();await rm(root,{recursive:true,force:true});}};
}
test('released device window retains authorized file queries, uploads, authoritative history and socket events',async t=>{
 const f=await fixture(undefined,true);let socket:WebSocket|undefined,rebuilding:Promise<void>|undefined,pending:ReturnType<typeof request>|undefined,pendingMove:ReturnType<typeof request>|undefined,pendingCopy:ReturnType<typeof request>|undefined;
 try{
  const base=await f.ready,headers={'x-api-key':f.key},events:any[]=[],profile=f.profiles[0],journal=profile.product.journal!,files=profile.options.server.nativeProcessFiles!;
  const get=async(path:string)=>{const response=await fetch(base+path,{headers});assert.equal(response.status,200,path);return (await response.json() as any).result;};
  const upload=async(id:string)=>{const form=new FormData();form.append('file',new Blob(['; layer_height = 0.2\nG1 X1\n']),id+'.gcode');form.append('file_id',id);const response=await fetch(base+'/server/files/upload',{method:'POST',headers,body:form});assert.equal(response.status,200);assert.equal((await response.json() as any).result.print_started,false);};
  await upload('retained');await journal.reserve({version:1,requestId:'history',fileId:'retained',nozzle:0,bed:0});await journal.transition('history',1,'cancelled');
  const original=await get('/server/history/list');assert.equal(original.count,1);const job=original.jobs[0];
  socket=new WebSocket(base.replace('http:','ws:')+'/websocket',{headers});socket.on('message',bytes=>events.push(JSON.parse(bytes.toString())));await once(socket,'open');socket.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'server.connection.identify',params:{client_name:'detached-test',version:'1',type:'web',url:'https://process.invalid'}}));await until(()=>events.some(e=>e.id===1));
  const outcome=Promise.withResolvers<{status:number;body:any}>();pending=request(base+'/server/files/delete_file',{method:'DELETE',headers:{...headers,'content-type':'application/json','transfer-encoding':'chunked'}},response=>{let bytes='';response.on('data',b=>bytes+=b);response.on('end',()=>outcome.resolve({status:response.statusCode!,body:JSON.parse(bytes)}));});pending.on('error',outcome.reject);pending.write('{"path":');await delay(25);
  const movedOutcome=Promise.withResolvers<number>();pendingMove=request(base+'/server/files/move',{method:'POST',headers:{...headers,'content-type':'application/json','transfer-encoding':'chunked'}},response=>{response.resume();response.on('end',()=>movedOutcome.resolve(response.statusCode!));});pendingMove.on('error',movedOutcome.reject);pendingMove.write('{"source":');await delay(25);
  const copiedOutcome=Promise.withResolvers<number>();pendingCopy=request(base+'/server/files/copy',{method:'POST',headers:{...headers,'content-type':'application/json','transfer-encoding':'chunked'}},response=>{response.resume();response.on('end',()=>copiedOutcome.resolve(response.statusCode!));});pendingCopy.on('error',copiedOutcome.reject);pendingCopy.write('{"source":');await delay(25);
  rebuilding=f.control.reinitialize();await f.detached;
  assert.equal(profile.options.server.nativeUploads!.status.closed,true);assert.equal(journal.closed,false);assert.equal(files.status.closed,false);assert(f.fixtures[0].transport.stops.every(n=>n===1));assert.equal(f.addresses.length,1);assert.equal(socket.readyState,WebSocket.OPEN);
  await assert.rejects(profile.options.server.nativeUploads!.metadata({filename:'retained.gcode'},new AbortController().signal),/closed/);await assert.rejects(profile.options.server.nativeUploads!.thumbnails({filename:'retained.gcode'},new AbortController().signal),/closed/);
  assert.equal((await get('/server/info')).native_host.ready,false);assert.equal((await fetch(base+'/server/files/list')).status,401);
  for(const path of ['/printer/files/info?file_id=retained','/server/files/list','/server/files/directory?path=gcodes&extended=true','/server/files/metadata?filename=retained.gcode','/server/files/thumbnails?filename=retained.gcode','/server/history/job?uid='+job.job_id,'/server/history/totals'])await get(path);
  assert.equal((await get('/server/history/list')).jobs[0].job_id,job.job_id);assert.equal(await (await fetch(base+'/server/files/gcodes/retained.gcode',{headers})).text(),'; layer_height = 0.2\nG1 X1\n');
  assert.equal((await fetch(base+'/printer/print/start',{method:'POST',headers:{...headers,'content-type':'application/json'},body:'{"filename":"retained.gcode"}'})).status,503);
  const offlineCopy=await fetch(base+'/server/files/copy',{method:'POST',headers:{...headers,'content-type':'application/json'},body:'{"source":"gcodes/retained.gcode","dest":"gcodes/new.gcode"}'});assert.equal(offlineCopy.status,200,await offlineCopy.clone().text());
  const offlineMove=await fetch(base+'/server/files/move',{method:'POST',headers:{...headers,'content-type':'application/json'},body:'{"source":"gcodes/new.gcode","dest":"gcodes/organized-offline.gcode"}'});assert.equal(offlineMove.status,200,await offlineMove.clone().text());
  const offlineDelete=await fetch(base+'/server/files/delete_file?path=gcodes/organized-offline.gcode',{method:'DELETE',headers});assert.equal(offlineDelete.status,200,await offlineDelete.clone().text());
  await until(()=>events.some(e=>e.method==='notify_filelist_changed'&&e.params[0].action==='delete_file'&&e.params[0].item.path==='organized-offline.gcode'));
  assert.equal((await get('/server/files/list'))[0].permissions,'rw');
  await upload('offline');await until(()=>events.some(e=>e.method==='notify_filelist_changed'&&e.params[0].item.file_id==='offline'));
  socket.send(JSON.stringify({jsonrpc:'2.0',id:2,method:'server.history.list'}));await until(()=>events.some(e=>e.id===2));assert.equal(events.find(e=>e.id===2).result.count,1);
  const deleted=await fetch(base+'/server/history/job?uid='+job.job_id,{method:'DELETE',headers});assert.equal(deleted.status,200);assert.equal((await get('/server/history/list')).count,0);assert.equal((await journal.get('history'))!.state,'cancelled');
  assert.equal((await fetch(base+'/server/history/reset_totals',{method:'POST',headers})).status,200);assert.equal((await get('/server/history/totals')).job_totals.total_jobs,0);
  await journal.reserve({version:1,requestId:'offline-history',fileId:'retained',nozzle:0,bed:0});await journal.transition('offline-history',1,'cancelled');await until(()=>events.some(e=>e.method==='notify_history_changed'&&e.params[0].action==='finished'&&e.params[0].job.metadata.native_request_id==='offline-history'));
  f.replacement.resolve();await rebuilding;assert.equal(f.profiles[1].product.journal,journal);assert.equal(f.profiles[1].options.server.nativeProcessFiles,files);assert.equal((await get('/server/info')).native_host.ready,true);assert.equal((await get('/server/files/list')).length,2);
  pending.end('"gcodes/retained.gcode"}');assert.equal((await outcome.promise).status,503);assert.equal((await get('/printer/files/info?file_id=retained')).id,'retained');
  assert.equal((await fetch(base+'/server/files/gcodes/offline.gcode',{method:'DELETE',headers})).status,200);assert.equal((await get('/server/files/list')).length,1);
  pendingMove.end('"gcodes/retained.gcode","dest":"gcodes/stale.gcode"}');assert.equal(await movedOutcome.promise,503);assert.equal(files.filename('retained'),'retained.gcode');
  pendingCopy.end('"gcodes/retained.gcode","dest":"gcodes/stale-copy.gcode"}');assert.equal(await copiedOutcome.promise,503);assert.equal((await get('/server/files/list')).length,1);
  const copied=await fetch(base+'/server/files/copy',{method:'POST',headers:{...headers,'content-type':'application/json'},body:'{"source":"gcodes/retained.gcode","dest":"gcodes/copied.gcode"}'});assert.equal(copied.status,200,await copied.clone().text());assert.equal(((await copied.json()) as any).result.action,'create_file');assert.notEqual((await get('/server/files/metadata?filename=copied.gcode')).file_id,'retained');assert.equal((await fetch(base+'/server/files/gcodes/copied.gcode',{method:'DELETE',headers})).status,200);
  const moved=await fetch(base+'/server/files/move',{method:'POST',headers:{...headers,'content-type':'application/json'},body:'{"source":"gcodes/retained.gcode","dest":"gcodes/organized.gcode"}'});assert.equal(moved.status,200,await moved.clone().text());assert.equal(((await moved.json()) as any).result.source_item.path,'retained.gcode');assert.equal((await get('/server/files/metadata?filename=organized.gcode')).file_id,'retained');assert.equal((await fetch(base+'/server/files/gcodes/retained.gcode',{headers})).status,404);
  t.diagnostic('Actual product host paused after old profile release; same process files/journal, prior API key and socket retained; no hardware motion acceptance.');
 }finally{f.replacement.resolve();pending?.destroy();pendingMove?.destroy();pendingCopy?.destroy();socket?.terminate();await rebuilding?.catch(()=>{});await f.close();}
});
test('process download admitted before retirement survives attachment, and final shutdown waits ignored process authorization',async()=>{
 const f=await fixture(),held=Promise.withResolvers<void>(),final=Promise.withResolvers<void>();let transfer:Promise<void>|undefined,stopping:Promise<void>|undefined;
 try{
  const base=await f.ready,headers={'x-api-key':f.key},form=new FormData();form.append('file',new Blob(['G1 X1\n']),'part.gcode');form.append('file_id','retained');assert.equal((await fetch(base+'/server/files/upload',{method:'POST',headers,body:form})).status,200);
  const files=f.profiles[0].options.server.nativeProcessFiles!,signal=new AbortController().signal;let consumed=false;
  transfer=files.download('/server/files/gcodes/retained.gcode',{transport:'http',signal,authorize:()=>held.promise},async()=>{consumed=true;});await until(()=>files.status.authorizing===1);
  await f.control.reinitialize();assert.equal(files.status.closed,false);assert.equal(files.status.downloads,1);assert.equal(consumed,false);held.resolve();await transfer;assert.equal(consumed,true);
  const blocked=files.download('/server/files/gcodes/retained.gcode',{transport:'http',signal,authorize:()=>final.promise},async()=>{throw Error('Cancelled download must not consume');});const rejected=assert.rejects(blocked,/closed/);await until(()=>files.status.authorizing===1);
  let terminal=false;stopping=f.running.then(()=>{terminal=true;});f.abort.abort();await rejected;await delay(25);assert.equal(terminal,false);assert.equal(f.db.status.closed,false);assert.equal(f.counts.processReleases,0);
  final.resolve();await stopping;assert.equal(f.db.status.closed,true);assert.equal(f.counts.databaseCloses,1);assert.equal(files.status.authorizing,0);
 }finally{held.resolve();final.resolve();await transfer?.catch(()=>{});f.abort.abort();await stopping?.catch(()=>{});await f.close();}
});
test('chunked same-path upload admitted by the old device cannot overwrite after replacement attaches',async t=>{
 const f=await fixture(undefined,true);let pending:ReturnType<typeof request>|undefined,rebuilding:Promise<void>|undefined;const events:any[]=[];
 try{
  const base=await f.ready,headers={'x-api-key':f.key},files=f.profiles[0].options.server.nativeProcessFiles!;
  const upload=async(content:string)=>{const form=new FormData();form.append('file',new Blob([content]),'target.gcode');return fetch(base+'/server/files/upload',{method:'POST',headers,body:form});};
  const before=await upload('G1 X1\n');assert.equal(before.status,200);const old=(await before.json() as any).result.file.id;
  const off=files.observeChanges(event=>events.push(event));
  try{
   const outcome=Promise.withResolvers<number|'ECONNRESET'>();
   pending=request(base+'/server/files/upload',{method:'POST',headers:{...headers,'content-type':'multipart/form-data; boundary=retired-upload','transfer-encoding':'chunked'}},response=>{response.resume();response.on('end',()=>outcome.resolve(response.statusCode!));});pending.on('error',error=>{if((error as NodeJS.ErrnoException).code==='ECONNRESET')outcome.resolve('ECONNRESET');else outcome.reject(error);});
   pending.write('--retired-upload\r\nContent-Disposition: form-data; name="file"; filename="target.gcode"\r\nContent-Type: application/octet-stream\r\n\r\nG1 X9');
   await until(()=>files.status.pending===1);
   assert.equal(f.profiles[0].options.server.nativeUploads!.status.pending,1,'The retiring device owner must join the staged process upload before releasing its generation');
   await assert.rejects(f.control.reinitialize(),/quiescent printer/);
   const restart=await fetch(base+'/printer/restart',{method:'POST',headers});assert.equal(restart.status,200,await restart.clone().text());
   rebuilding=until(()=>f.profiles.length===2&&f.addresses.length===2);await until(()=>f.counts.calls===2);await f.detached;
   assert.equal(files.status.closed,false);assert.equal(files.status.pending,0);assert.equal(events.length,0);
   f.replacement.resolve();await rebuilding;assert.equal(f.profiles.length,2);assert.equal(f.profiles[1].options.server.nativeProcessFiles,files);
   // Network cancellation sends 503 then destroys an incomplete request. The
   // transport may observe that response or the reset; neither may commit.
   pending.end('\n\r\n--retired-upload--\r\n');const cancelled=await outcome.promise;assert.ok(cancelled===503||cancelled==='ECONNRESET',String(cancelled));
   const metadata=await (await fetch(base+'/server/files/metadata?filename=target.gcode',{headers})).json() as any;assert.equal(metadata.result.file_id,old);
   assert.equal(await (await fetch(base+'/server/files/gcodes/target.gcode',{headers})).text(),'G1 X1\n');assert.equal(events.length,0);
   const current=await upload('G1 X2\n');assert.equal(current.status,200,await current.clone().text());const result=(await current.json() as any).result;
   assert.notEqual(result.file.id,old);assert.equal(result.action,'create_file');assert.equal(result.print_started,false);assert.equal(result.print_queued,false);
   assert.equal((await fetch(base+'/printer/files/info?file_id='+old,{headers})).status,404);assert.equal(await (await fetch(base+'/server/files/gcodes/target.gcode',{headers})).text(),'G1 X2\n');
   assert.equal(events.length,1);assert.equal(events[0].action,'create_file');assert.equal(events[0].item.path,'target.gcode');assert.equal(events[0].item.file_id,result.file.id);assert.equal(files.status.pending,0);
   t.diagnostic(JSON.stringify({cancelled,scope:'Old chunked upload rejected without replacement/events; standard restart admits a new immutable replacement on the same process store. Two simulated MCU generations, no physical printer acceptance.'}));
  }finally{off();}
 }finally{f.replacement.resolve();pending?.destroy();await rebuilding?.catch(()=>{});await f.close();}
});
test('unconfirmed device stop blocks upload and move overwrites without changing either identity',async()=>{
 const f=await fixture('stop');
 try{
  const base=await f.ready,headers={'x-api-key':f.key},upload=async(name:string,content:string)=>{const form=new FormData();form.append('file',new Blob([content]),name);return fetch(base+'/server/files/upload',{method:'POST',headers,body:form});};
  const target=await upload('target.gcode','G1 X1\n'),source=await upload('source.gcode','G1 X9\n');assert.equal(target.status,200);assert.equal(source.status,200);
  const ids=[(await target.json() as any).result.file.id,(await source.json() as any).result.file.id],events:any[]=[],files=f.profiles[0].options.server.nativeProcessFiles!,off=files.observeChanges(e=>events.push(e));
  try{
   await assert.rejects(f.control.reinitialize(),/stop|failed/i);assert.equal(f.profiles.length,1);assert.equal(f.counts.calls,1);
   assert.equal((await upload('target.gcode','G1 X2\n')).status,503);
   const moved=await fetch(base+'/server/files/move',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({source:'gcodes/source.gcode',dest:'gcodes/target.gcode'})});assert.equal(moved.status,503);
   for(const [i,name] of ['target','source'].entries()){const result=await (await fetch(base+'/server/files/metadata?filename='+name+'.gcode',{headers})).json() as any;assert.equal(result.result.file_id,ids[i]);}
   assert.equal(await (await fetch(base+'/server/files/gcodes/target.gcode',{headers})).text(),'G1 X1\n');assert.equal(events.length,0);assert.equal(files.status.pending,0);
  }finally{off();}
 }finally{await f.close();}
});
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
  for(const path of ['/server/files/list','/server/files/directory','/server/history/list','/server/history/totals'])assert.equal((await fetch(base+path,{headers})).status,200,path);
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
