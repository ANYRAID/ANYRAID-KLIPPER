import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {request} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';
import {ConfiguredMoonraker,type NativePrinterBinding} from '../src/moonraker/configured-server.ts';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {NativeObjects,type NativeObjectReader} from '../src/moonraker/native-objects.ts';
import {NativePrintUploads} from '../src/moonraker/native-print-uploads.ts';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {PrintController} from '../src/operations/print.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
const information={connected:false,state:'disconnected' as const,components:[],failedComponents:[],directories:[],warnings:[],version:'attachment-test',missingRequirements:[]};
async function until(check:()=>boolean){const end=performance.now()+4000;while(!check()){assert(performance.now()<end,'Attachment timeout');await delay(5);}}
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'native-attach-')),config=join(root,'moonraker.conf'),db=await DatabaseStore.open({path:join(root,'api.db')}),files=await PublishedPrintFiles.open(join(root,'files'));
 await writeFile(config,'[server]\nhost=127.0.0.1\nport=0');let service:ConfiguredMoonraker|undefined;
 const generations:{binding:NativePrinterBinding;journal:PrintJournal;released:boolean;reads:number;temperature:number;starts:number}[]=[];
 async function generation(isolated=false){
  const journal=await PrintJournal.open({path:join(root,isolated?'jobs-'+generations.length+'.db':'jobs.db'),deviceId:'test'}),gate=new MaintenanceGate();
  const controller=new PrintController({async prepare(){},async start(){g.starts++;},async pause(){},async resume(){},async finish(){},async stop(){}},{maxNozzle:300,maxBed:130},{},{journal,maintenanceGate:gate});
  const uploads=await NativePrintUploads.open(files,gate,{metadataRoot:join(root,isolated?'metadata-'+generations.length:'metadata')});
  const g={binding:undefined as unknown as NativePrinterBinding,journal,released:false,reads:0,temperature:20+generations.length,starts:0};
  const objects=new NativeObjects(new Map<string,NativeObjectReader>([['heaters',()=>({available_sensors:['temperature_sensor chamber'],available_monitors:[]})],['temperature_sensor chamber',()=>{if(g.released)throw Error('Old device read');g.reads++;return {temperature:g.temperature};}]]),()=>performance.now()/1000);
  g.binding={controller,gate,objects,uploads,compatibility:{async start(){return {fileId:'job',nozzle:200,bed:60};}},host:()=>{if(g.released)throw Error('Old host read');return {group_state:'ready',hardware_state:'ready',print_state:controller.state,homed_axes:'',closing:false,admission_closed:gate.status.closed,maintenance:gate.status.maintenance,mcus:[{id:'mcu',state:'ready'}]};}};generations.push(g);return g;
 }
 const first=await generation();service=await ConfiguredMoonraker.loadAuthorized(config,{information,database:db,authorization:{issuer:'https://attachment.invalid'},systemInformation:{},procStats:{},productPrint:first.binding.controller,maintenanceGate:first.binding.gate,nativeHost:first.binding.host,nativeObjects:first.binding.objects,nativeUploads:first.binding.uploads,productPrintCompatibility:first.binding.compatibility,nativePrinterIdentity:{configFile:join(root,'printer.cfg'),softwareVersion:'test'}});
 const address=await service.start(),base=`http://127.0.0.1:${address.port}`,key=service.authorization!.localApiKey();
 const created=await (await fetch(base+'/access/user',{method:'POST',headers:{'x-api-key':key,'content-type':'application/json'},body:JSON.stringify({username:'operator',password:'test-only-password'})})).json() as any;
 const headers={authorization:'Bearer '+created.result.token};
 const uploaded=new FormData();uploaded.append('file',new Blob(['G1 X1\n']),'part.gcode');uploaded.append('file_id','job');assert.equal((await fetch(base+'/server/files/upload',{method:'POST',headers,body:uploaded})).status,201);
 async function retire(g:typeof first,outcome:'stopped'|'failed'='stopped'){await service!.retireNativePrinter();g.released=true;await g.journal.close();service!.confirmNativeRetirement(outcome);}
 return {root,config,db,files,service,first,base,key,headers,generation,retire,async close(){await service!.close();for(const g of generations){await g.binding.uploads?.close();await g.journal.close();}await files.close();await db.close();await rm(root,{recursive:true,force:true});}};
}
test('attachment preserves JWT, socket and process stores; replaces uploads, subscriptions and maintenance gate',async t=>{
 const f=await fixture(),events:any[]=[];let socket:WebSocket|undefined;
 try{
  socket=new WebSocket(f.base.replace('http:','ws:')+'/websocket',{headers:f.headers});socket.on('message',data=>events.push(JSON.parse(data.toString())));await once(socket,'open');
  socket.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'server.connection.identify',params:{client_name:'attachment-test',version:'1',type:'web',url:'https://attachment.invalid'}}));await until(()=>events.some(e=>e.id===1));
  socket.send(JSON.stringify({jsonrpc:'2.0',id:2,method:'printer.objects.subscribe',params:{objects:{'temperature_sensor chamber':null}}}));await until(()=>events.some(e=>e.id===2));
  await f.retire(f.first);const oldReads=f.first.reads;
  const next=await f.generation(),begin=performance.now();await f.service.attachNativePrinter(next.binding);t.diagnostic(JSON.stringify({attachmentMs:performance.now()-begin,scope:'Synthetic controller and read-only objects; no MCU hardware restart'}));
  assert.equal(socket.readyState,WebSocket.OPEN);assert.equal(f.service.status.phase,'listening');assert.equal(f.service.authorization!.localApiKey(),f.key);assert.equal(f.db.status.closed,false);assert.equal(f.service.maintenanceGate,next.binding.gate);assert.equal(f.service.nativeGenerationStatus?.generation,2);
  const info=await (await fetch(f.base+'/server/info',{headers:f.headers})).json() as any;assert.equal(info.result.klippy_state,'ready');assert.equal(info.result.native_host.ready,true);
  await until(()=>events.some(e=>e.method==='notify_klippy_disconnected')&&events.some(e=>e.method==='notify_klippy_ready'));
  await delay(300);assert.equal(f.service.nativeSubscriptionStatus?.clients,0);assert.equal(f.first.reads,oldReads);
  socket.send(JSON.stringify({jsonrpc:'2.0',id:3,method:'printer.objects.subscribe',params:{objects:{'temperature_sensor chamber':null}}}));await until(()=>events.some(e=>e.id===3));assert.equal(events.find(e=>e.id===3).result.status['temperature_sensor chamber'].temperature,21);
  next.temperature=24;await until(()=>events.some(e=>e.method==='notify_status_update'&&e.params[0]['temperature_sensor chamber']?.temperature===24));
  assert.equal((await fetch(f.base+'/server/database/compact',{method:'POST',headers:f.headers})).status,200);
  const start=await fetch(f.base+'/printer/print/start',{method:'POST',headers:{...f.headers,'content-type':'application/json'},body:JSON.stringify({filename:'job.gcode'})});assert.equal(start.status,200);
  await until(()=>next.binding.controller.state==='printing');assert.equal(next.starts,1);
  assert.equal((await fetch(f.base+'/server/database/compact',{method:'POST',headers:f.headers})).status,409);
  assert.equal((await fetch(f.base+'/printer/print/cancel',{method:'POST',headers:f.headers})).status,200);
  assert.equal((await fetch(f.base+'/server/files/gcodes/job.gcode',{headers:f.headers})).status,200);assert.equal((await fetch(f.base+'/server/files/list',{headers:f.headers})).status,200);
  const upload=new FormData();upload.append('file',new Blob(['G1 X2\n']),'fresh.gcode');upload.append('file_id','fresh');assert.equal((await fetch(f.base+'/server/files/upload',{method:'POST',headers:f.headers,body:upload})).status,201);assert.equal(next.binding.uploads!.status.published,1);assert.equal(f.first.binding.uploads!.status.published,1);
  const history=(await (await fetch(f.base+'/server/history/list',{headers:f.headers})).json() as any).result;assert.equal(history.count,1);
  await f.retire(next);const third=await f.generation();await f.service.attachNativePrinter(third.binding);const preserved=(await (await fetch(f.base+'/server/history/list',{headers:f.headers})).json() as any).result;assert.equal(preserved.jobs[0].job_id,history.jobs[0].job_id);assert.equal(preserved.jobs[0].status,'cancelled');assert.equal(third.starts,0);assert.equal(f.service.nativeSubscriptionStatus?.clients,0);
 }finally{socket?.terminate();await f.close();}
});
for(const rpc of [false,true])test(`HTTP admitted before retirement cannot run a new-generation print after delayed body (RPC=${rpc})`,async()=>{
 const f=await fixture();let pending:ReturnType<typeof request>|undefined;
 try{
  const outcome=Promise.withResolvers<{status:number;body:any}>();pending=request(f.base+(rpc?'/server/jsonrpc':'/printer/print/start'),{method:'POST',headers:{...f.headers,'content-type':'application/json','transfer-encoding':'chunked'}},response=>{let bytes='';response.on('data',b=>bytes+=b);response.on('end',()=>outcome.resolve({status:response.statusCode!,body:JSON.parse(bytes)}));});pending.on('error',outcome.reject);
  pending.write(rpc?'{"jsonrpc":"2.0","id":1,"method":"printer.print.start","params":{"filename":':'{"filename":');
  await until(()=>f.service.status.requests===1);await f.retire(f.first);const next=await f.generation();await f.service.attachNativePrinter(next.binding);
  pending.end(rpc?'"job.gcode"}}':'"job.gcode"}');const result=await outcome.promise;
  if(rpc){assert(result.body.error);assert.equal(result.body.error.code,503);}else assert.equal(result.status,503);
  assert.equal(next.starts,0);assert.equal(next.binding.controller.state,'idle');
 }finally{pending?.destroy();await f.close();}
});
test('unconfirmed or failed retirement rejects candidates without taking their ownership',async()=>{
 const f=await fixture();try{
  const next=await f.generation(true);await assert.rejects(f.service.attachNativePrinter(next.binding),/not ready/);
  const retirement=f.service.retireNativePrinter();assert.throws(()=>f.service.confirmNativeRetirement('stopped'),/not drained/);await retirement;
  await assert.rejects(f.service.attachNativePrinter(next.binding),/not confirmed/);f.service.confirmNativeRetirement('failed');await assert.rejects(f.service.attachNativePrinter(next.binding),/not confirmed/);assert.equal(next.binding.gate.status.closed,false);assert.equal(next.binding.uploads!.status.closed,false);
 }finally{await f.close();}
});
test('synchronous product route preparation failure never publishes ready and can be cleaned before explicit retry',async()=>{
 const f=await fixture();try{
  await f.retire(f.first);const next=await f.generation(),before=f.service.klippyNotifications.sent;
  await assert.rejects(f.service.attachNativePrinter(next.binding,()=>{throw Error('Product routes failed');}),/routes failed/);
  assert.equal(next.binding.gate.status.closed,true);assert.equal(next.binding.uploads!.status.closed,true);assert.equal(f.service.nativeGenerationStatus?.drained,true);assert.equal(f.service.klippyNotifications.sent,before);assert.equal((await (await fetch(f.base+'/server/info',{headers:f.headers})).json() as any).result.native_host.ready,false);
  f.service.confirmNativeRetirement('stopped');await next.journal.close();const third=await f.generation();await f.service.attachNativePrinter(third.binding);assert.equal(f.service.nativeGenerationStatus?.generation,3);assert.equal((await fetch(f.base+'/printer/print/status',{headers:f.headers})).status,200);
 }finally{await f.close();}
});
test('retirement waits for an ignored file authorization before accepting another generation',async()=>{
 const f=await fixture(),held=Promise.withResolvers<void>();let retirement:Promise<void>|undefined;
 try{
  const mutation=f.first.binding.uploads!.remove({path:'gcodes/job.gcode'},{transport:'http',signal:new AbortController().signal,authorize:()=>held.promise});
  const rejected=assert.rejects(mutation,/closed/);await until(()=>f.first.binding.uploads!.status.authorizing===1);
  let drained=false;retirement=f.service.retireNativePrinter().then(()=>{drained=true;});await rejected;await delay(20);
  assert.equal(drained,false);assert.equal(f.service.nativeGenerationStatus?.drained,false);assert.throws(()=>f.service.confirmNativeRetirement('stopped'),/not drained/);
  const next=await f.generation(true),second=await f.generation(true),attaching=f.service.attachNativePrinter(next.binding);
  const waiting=assert.rejects(attaching,/not confirmed/);await assert.rejects(f.service.attachNativePrinter(second.binding),/not ready/);assert.equal(second.binding.gate.status.closed,false);
  held.resolve();await retirement;await waiting;assert.equal(f.first.binding.uploads!.status.authorizing,0);assert.equal(next.binding.gate.status.closed,false);assert.equal(f.files.status.publishedFiles,1);
 }finally{held.resolve();await retirement;await f.close();}
});
test('process shutdown keeps its database alive until ignored file authorization drains',async()=>{
 const f=await fixture(),held=Promise.withResolvers<void>();let closing:Promise<void>|undefined;
 try{
  const mutation=f.first.binding.uploads!.remove({path:'gcodes/job.gcode'},{transport:'http',signal:new AbortController().signal,authorize:()=>held.promise});
  const rejected=assert.rejects(mutation,/closed/);await until(()=>f.first.binding.uploads!.status.authorizing===1);
  let closed=false;closing=f.service.close().then(()=>{closed=true;});await rejected;await delay(20);assert.equal(closed,false);assert.equal(f.db.status.closed,false);
  held.resolve();await closing;assert.equal(f.db.status.closed,true);assert.equal(f.first.binding.uploads!.status.authorizing,0);
 }finally{held.resolve();await closing;await f.close();}
});
