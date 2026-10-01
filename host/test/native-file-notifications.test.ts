import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import WebSocket from 'ws';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
import {NativePrintUploads} from '../src/moonraker/native-print-uploads.ts';
import {PrintController} from '../src/operations/print.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
import {ApiError} from '../src/moonraker/rpc.ts';
const until=async(check:()=>boolean)=>{const end=Date.now()+4000;while(!check()){assert(Date.now()<end,'File notification timed out');await new Promise(r=>setTimeout(r,5));}};
test('durable file events have per-file authorization and ordered delivery; held clients cannot block files or stop',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'native-file-events-')),gate=new MaintenanceGate(),journal=await PrintJournal.open({path:join(dir,'jobs.db'),deviceId:'printer'}),files=await PublishedPrintFiles.open(join(dir,'files')),uploads=new NativePrintUploads(files,gate,{stagingRoot:dir});
 let stops=0;const controller=new PrintController({async prepare(){},async start(){},async pause(){},async resume(){},async finish(){},async stop(){stops++;}},{maxNozzle:300,maxBed:130},{},{journal,maintenanceGate:gate});
 const held=Promise.withResolvers<void>(),sockets:WebSocket[]=[],events:any[][]=[[],[],[]];let service:ConfiguredMoonraker|undefined;
 try{
  const config=join(dir,'moonraker.conf');await writeFile(config,'[server]\nhost=127.0.0.1\nport=0');
  service=await ConfiguredMoonraker.load(config,{nativeUploads:uploads,productPrint:controller,maintenanceGate:gate,information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'test',missingRequirements:[]},authorize:()=>{},notificationLimits:{pending:16,perClient:2,timeoutMs:3000},authorizeNotification(method,params,context){
   if(method!=='notify_filelist_changed')throw new Error('Not subscribed');const event=params[0] as any;assert.equal(event.item.root,'gcodes');assert.equal(event.item.path,event.item.file_id+'.gcode');
   const role=context.request.headers['x-role'];if(role==='slow')return held.promise;if(role!=='allowed'||event.item.file_id==='secret')throw new Error('No file permission');
  }});
  const {port}=await service.start(),base=`http://127.0.0.1:${port}`;
  for(const [i,role] of ['allowed','denied','slow'].entries()){const socket=new WebSocket(base.replace('http:','ws:')+'/websocket',{headers:{'x-role':role}});socket.on('message',data=>{const event=JSON.parse(data.toString());if(event.method==='notify_filelist_changed')events[i].push(event);});sockets.push(socket);await once(socket,'open');}
  const upload=async(id:string)=>{const form=new FormData();form.append('file',new Blob(['G1 X1\n']),'模型.gcode');form.append('file_id',id);return fetch(base+'/server/files/upload',{method:'POST',body:form});};
  assert.equal((await upload('visible')).status,200);await until(()=>events[0].length===1);
  const created=events[0][0].params[0],listing=(await (await fetch(base+'/server/files/list')).json()).result[0];assert.equal(created.action,'create_file');assert.equal(created.item.modified,listing.modified);assert.equal(created.item.size,6);assert.equal(created.item.permissions,'rw');assert.equal(created.item.name,'模型.gcode');assert.equal(created.item.sha256,listing.sha256);
  assert.equal((await upload('visible')).status,409);assert.equal(service.fileNotifications.received,1,'Failed upload cannot announce creation');
  assert.equal((await upload('secret')).status,200);assert.equal((await fetch(base+'/server/files/gcodes/visible.gcode',{method:'DELETE'})).status,200);
  await until(()=>events[0].length===2&&service!.fileNotifications.overflow>0);assert.deepEqual(events[0].map(e=>e.params[0].action),['create_file','delete_file']);const removed=events[0][1].params[0];assert.equal(removed.item.size,0);assert.equal(removed.item.modified,0);assert.equal(removed.item.permissions,'');assert.equal(removed.item.sha256,created.item.sha256);assert.equal(events[1].length,0);assert.equal(events[2].length,0);assert(service.fileNotifications.denied>=3);
  assert.equal((await fetch(base+'/server/files/gcodes/visible.gcode',{method:'DELETE'})).status,404);assert.equal(service.fileNotifications.received,3);
  await controller.start({version:1,requestId:'job',fileId:'secret',nozzle:0,bed:0});await controller.fault(new Error('test stop'));assert.equal(stops,1);assert.equal(controller.state,'failed');
  // Unsettled policy work remains accounted for; shutdown reports its deadline.
  await assert.rejects(service.close(),/shutdown deadline/);assert.equal(files.changeObservers.count,0);assert.equal(files.changeObservers.failures,0);held.resolve();await service.close();
 }finally{held.resolve();for(const socket of sockets)socket.terminate();await service?.close();await uploads.close();await files.close();await journal.close();await rm(dir,{recursive:true,force:true});}
});
test('directory HTTP and verb-prefixed RPC changes publish only durable authorized events',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'native-directory-events-')),gate=new MaintenanceGate(),journal=await PrintJournal.open({path:join(dir,'jobs.db'),deviceId:'printer'}),files=await PublishedPrintFiles.open(join(dir,'files')),uploads=new NativePrintUploads(files,gate),controller=new PrintController({async prepare(){},async start(){},async pause(){},async resume(){},async finish(){},async stop(){}},{maxNozzle:300,maxBed:130},{},{journal,maintenanceGate:gate});
 const sockets:WebSocket[]=[],events:any[][]=[[],[]];let service:ConfiguredMoonraker|undefined;
 try{
  const config=join(dir,'moonraker.conf');await writeFile(config,'[server]\nhost=127.0.0.1\nport=0');
  service=await ConfiguredMoonraker.load(config,{nativeUploads:uploads,productPrint:controller,maintenanceGate:gate,information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'test',missingRequirements:[]},authorize(method,params){if(method==='server.files.post_directory'&&params.path==='gcodes/private')throw new ApiError(403,'Denied directory');},authorizeNotification(method,_params,context){if(method!=='notify_filelist_changed'||context.request.headers['x-role']!=='allowed')throw new Error('Denied notification');}});
  const {port}=await service.start(),base=`http://127.0.0.1:${port}`;
  for(const [i,role] of ['allowed','denied'].entries()){const socket=new WebSocket(base.replace('http:','ws:')+'/websocket',{headers:{'x-role':role}});socket.on('message',data=>{const message=JSON.parse(data.toString());if(message.method==='notify_filelist_changed')events[i].push(message.params[0]);});sockets.push(socket);await once(socket,'open');}
  const rpc=async(method:string,path:string)=>(await (await fetch(base+'/server/jsonrpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{path}})})).json());
  const denied=await rpc('server.files.post_directory','gcodes/private');assert(denied.error);assert.deepEqual((await files.directoryCatalog('',new AbortController().signal)).directories,[]);assert.equal(service.fileNotifications.received,0);
  const created=await rpc('server.files.post_directory','gcodes/parts');assert.equal(created.result.action,'create_dir');assert.equal(created.result.item.path,'parts');await until(()=>events[0].length===1);
  const duplicate=await rpc('server.files.post_directory','gcodes/parts');assert(duplicate.error);assert.equal(service.fileNotifications.received,1);
  const removed=await fetch(base+'/server/files/directory',{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({path:'gcodes/parts'})});assert.equal(removed.status,200);await until(()=>events[0].length===2);assert.deepEqual(events[0].map(e=>e.action),['create_dir','delete_dir']);assert.equal(events[0][1].item.permissions,'');assert.equal(events[1].length,0);assert.deepEqual((await files.directoryCatalog('',new AbortController().signal)).directories,[]);
 }finally{for(const socket of sockets)socket.terminate();await service?.close();await uploads.drain();await files.close();await journal.close();await rm(dir,{recursive:true,force:true});}
});
