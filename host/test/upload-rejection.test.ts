import test from 'node:test';
import assert from 'node:assert/strict';
import {request,type IncomingMessage} from 'node:http';
import {PassThrough} from 'node:stream';
import {discardRejectedUploadBody} from '../src/moonraker/rejected-upload-body.ts';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MoonrakerNetwork} from '../src/moonraker/server.ts';
import {NativePrintUploads} from '../src/moonraker/native-print-uploads.ts';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {JsonRpcDispatcher,ApiError} from '../src/moonraker/rpc.ts';

test('early upload rejection waits for a small in-flight body before closing and never stages it',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'reject-upload-')),files=await PublishedPrintFiles.open(join(dir,'files')),uploads=new NativePrintUploads(files,new MaintenanceGate(),{stagingRoot:dir}),denied=Promise.withResolvers<void>();
 const network=new MoonrakerNetwork(new JsonRpcDispatcher(),{nativeUploads:uploads,authorize(){denied.resolve();throw new ApiError(401,'Denied');}});let client:ReturnType<typeof request>|undefined;
 try{
  const address=await network.listen();let sent=false;
  const received=new Promise<{status:number|undefined;body:string;sent:boolean}>((resolve,reject)=>{
   client=request({hostname:'127.0.0.1',port:address.port,path:'/server/files/upload',method:'POST',headers:{'content-type':'multipart/form-data; boundary=test','content-length':'32000'}},res=>{let body='';const sentWhenResponse=sent;res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,body,sent:sentWhenResponse}));res.on('error',reject);});client.on('error',reject);client.flushHeaders();
  });
  void received.catch(()=>{});await denied.promise;await delay(30);assert.equal(network.status.requests,1);assert.equal(network.status.bufferedBytes,8*65536);sent=true;client!.end(Buffer.alloc(32000,65));
  const result=await received;assert.equal(result.status,401);assert.equal(result.sent,true,'response must not close the connection while the bounded body is still being sent');assert.equal(JSON.parse(result.body).error.code,401);assert.equal(files.status.publishedFiles,0);assert.deepEqual(await readdir(dir),['files']);assert.equal(network.status.requests,0);assert.equal(network.status.bufferedBytes,0);
 }finally{client?.destroy();await network.close();await uploads.close();await files.close();await rm(dir,{recursive:true,force:true});}
});
test('rejection discard bounds unknown bodies, stalls and shutdown without retaining listeners',async()=>{
 const make=(length?:string)=>Object.assign(new PassThrough(),{headers:length===undefined?{}:{'content-length':length}}) as unknown as IncomingMessage;
 const large=make('65537');await discardRejectedUploadBody(large,new AbortController().signal);assert.equal(large.readableFlowing,null);large.destroy();
 const chunked=make(),draining=discardRejectedUploadBody(chunked,new AbortController().signal);chunked.emit('data',Buffer.alloc(65537));await draining;assert.equal(chunked.listenerCount('data'),0);assert.equal(chunked.isPaused(),true);chunked.destroy();
 const stalled=make('100'),started=performance.now();await discardRejectedUploadBody(stalled,new AbortController().signal);assert(performance.now()-started>=200);assert(performance.now()-started<1500);assert.equal(stalled.listenerCount('end'),0);stalled.destroy();
 const aborted=make(),abort=new AbortController(),pending=discardRejectedUploadBody(aborted,abort.signal);abort.abort();await pending;assert.equal(aborted.listenerCount('data'),0);assert.equal(aborted.listenerCount('error'),0);aborted.destroy();
});
test('repeated fetch multipart denial returns 401 without publishing a file',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'reject-fetch-')),files=await PublishedPrintFiles.open(join(dir,'files')),uploads=new NativePrintUploads(files,new MaintenanceGate(),{stagingRoot:dir});
 const network=new MoonrakerNetwork(new JsonRpcDispatcher(),{nativeUploads:uploads,authorize(){throw new ApiError(401,'Denied');}});
 try{const {port}=await network.listen();for(let i=0;i<40;i++){const body=new FormData();body.append('file',new Blob(['G1 X1 E1\n'.repeat(3000)]),'test.gcode');const response=await fetch(`http://127.0.0.1:${port}/server/files/upload`,{method:'POST',body,signal:AbortSignal.timeout(3000)});assert.equal(response.status,401);assert.equal((await response.json()).error.code,401);}assert.equal(files.status.publishedFiles,0);assert.deepEqual(await readdir(dir),['files']);assert.equal(uploads.status.pending,0);}finally{await network.close();await uploads.close();await files.close();await rm(dir,{recursive:true,force:true});}
});
test('network shutdown aborts a pending rejection discard and releases request reservations',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'reject-stop-')),files=await PublishedPrintFiles.open(join(dir,'files')),uploads=new NativePrintUploads(files,new MaintenanceGate(),{stagingRoot:dir}),denied=Promise.withResolvers<void>();
 const network=new MoonrakerNetwork(new JsonRpcDispatcher(),{nativeUploads:uploads,authorize(){denied.resolve();throw new ApiError(401,'Denied');}});let client:ReturnType<typeof request>|undefined;
 try{const {port}=await network.listen();client=request({hostname:'127.0.0.1',port,path:'/server/files/upload',method:'POST',headers:{'content-length':'100','content-type':'multipart/form-data; boundary=test'}},r=>r.resume());client.on('error',()=>{});client.flushHeaders();await denied.promise;await delay(10);assert.equal(network.status.requests,1);await network.close();assert.equal(network.status.requests,0);assert.equal(network.status.bufferedBytes,0);assert.equal(uploads.status.pending,0);}finally{client?.destroy();await network.close();await uploads.close();await files.close();await rm(dir,{recursive:true,force:true});}
});
test('exhausted buffer capacity rejects before draining or authorizing a body',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'reject-budget-')),files=await PublishedPrintFiles.open(join(dir,'files')),uploads=new NativePrintUploads(files,new MaintenanceGate(),{stagingRoot:dir});let authorized=0,client:ReturnType<typeof request>|undefined;
 const network=new MoonrakerNetwork(new JsonRpcDispatcher(),{nativeUploads:uploads,maxBufferedBytes:1,authorize(){authorized++;}});
 try{const {port}=await network.listen(),start=performance.now();const status=await new Promise<number|undefined>((resolve,reject)=>{client=request({hostname:'127.0.0.1',port,path:'/server/files/upload',method:'POST',headers:{'content-length':'100','content-type':'multipart/form-data; boundary=test'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});client.on('error',reject);client.flushHeaders();});assert.equal(status,429);assert(performance.now()-start<200,'capacity refusal must not wait for the rejection discard deadline');assert.equal(authorized,0);assert.equal(network.status.bufferedBytes,0);assert.equal(network.status.requests,0);}finally{client?.destroy();await network.close();await uploads.close();await files.close();await rm(dir,{recursive:true,force:true});}
});
