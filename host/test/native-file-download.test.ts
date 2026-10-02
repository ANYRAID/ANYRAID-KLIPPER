import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,open,writeFile,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {request as httpRequest,type IncomingMessage} from 'node:http';
import {NativePrintUploads,registerNativeFileInfo} from '../src/moonraker/native-print-uploads.ts';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {PrintSnapshotBudget} from '../src/gcode/snapshot-budget.ts';
import {MoonrakerNetwork,type MoonrakerNetworkOptions} from '../src/moonraker/server.ts';
import {JsonRpcDispatcher,ApiError,type Json} from '../src/moonraker/rpc.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {ThumbnailDownloads} from '../src/moonraker/thumbnail-download.ts';
import {FileMetadataStore} from '../src/moonraker/file-metadata.ts';
import {ThumbnailStorage,publishThumbnailMetadata} from '../src/moonraker/thumbnail-storage.ts';
import sharp from 'sharp';
const signal=()=>new AbortController().signal;
async function until(check:()=>boolean){const end=Date.now()+5000;while(!check()){assert(Date.now()<end,'Download did not settle');await new Promise(resolve=>setTimeout(resolve,5));}}
async function fixture(options:{authorize?:MoonrakerNetworkOptions['authorize'];maxDownloadBytes?:number;maxOutputBytes?:number;maxDownloads?:number;thumbnails?:ThumbnailDownloads}={}){
 const dir=await mkdtemp(join(tmpdir(),'native-download-')),printBudget=new PrintSnapshotBudget({maxSnapshots:1,maxBytes:64*1024**2}),files=await PublishedPrintFiles.open(join(dir,'files'),{budget:printBudget}),uploads=new NativePrintUploads(files,new MaintenanceGate(),{stagingRoot:dir,maxDownloads:options.maxDownloads,maxDownloadBytes:options.maxDownloadBytes}),rpc=new JsonRpcDispatcher(),endpoints=new EndpointRegistry(rpc);registerNativeFileInfo(endpoints,uploads);
 const network=new MoonrakerNetwork(rpc,{nativeUploads:uploads,thumbnails:options.thumbnails,origins:['https://printer.example'],endpoints,maxOutputBytes:options.maxOutputBytes,authorize:options.authorize??(()=>{})}),address=await network.listen(),base=`http://127.0.0.1:${address.port}`;
 return {dir,files,uploads,network,printBudget,base,async publish(id:string,data:Buffer,name='模型.gcode'){const path=join(dir,'source-'+id);await writeFile(path,data);const source=await open(path,'r');try{return await files.publish(id,name,source,signal());}finally{await source.close();}},async close(){await uploads.close();await network.close();await files.close();await rm(dir,{recursive:true,force:true});}};
}
test('catalog downloads exact binary bytes, HEAD, validators and ranges beyond the JSON response bound',async()=>{
 const f=await fixture();try{
  const data=Buffer.alloc(2*1024**2);for(let i=0;i<data.length;i++)data[i]=i%256;const record=await f.publish('binary',data);
  const catalog=(await (await fetch(f.base+'/server/files/list')).json()).result,path='/server/files/gcodes/'+catalog[0].path,url=f.base+path;
  const response=await fetch(url);assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),data);assert.equal(response.headers.get('etag'),'"'+record.sha256+'"');assert.match(response.headers.get('content-disposition')!,/filename\*=UTF-8''%E6/);assert.equal(response.headers.get('content-type'),'application/octet-stream');
  const preflight=await fetch(url,{method:'OPTIONS',headers:{origin:'https://printer.example','access-control-request-method':'GET','access-control-request-headers':'Range, If-Range'}});assert.equal(preflight.status,204);assert.match(preflight.headers.get('access-control-allow-headers')!,/Range, If-Range/);
  const cross=await fetch(url,{headers:{origin:'https://printer.example',range:'bytes=0-1'}});assert.equal(cross.status,206);assert.match(cross.headers.get('access-control-expose-headers')!,/ETag/);assert.equal((await cross.arrayBuffer()).byteLength,2);
  const head=await fetch(url,{method:'HEAD'});assert.equal(head.headers.get('content-length'),String(data.length));assert.equal((await head.arrayBuffer()).byteLength,0);
  const conditional=await fetch(url,{headers:{'if-none-match':'W/"'+record.sha256+'"'}});assert.equal(conditional.status,304);assert.equal((await conditional.arrayBuffer()).byteLength,0);
  for(const [range,start,end] of [['bytes=9-21',9,22],['bytes=-20',data.length-20,data.length],['bytes=2097140-',2097140,data.length]] as const){const partial=await fetch(url,{headers:{range}});assert.equal(partial.status,206);assert.equal(partial.headers.get('content-range'),`bytes ${start}-${end-1}/${data.length}`);assert.deepEqual(Buffer.from(await partial.arrayBuffer()),data.subarray(start,end));}
  for(const range of ['bytes=2097152-','bytes=10-3','bytes=-0','bytes=999999999999999999999-']){const partial=await fetch(url,{headers:{range}});assert.equal(partial.status,416);await partial.arrayBuffer();}
  const changed=await fetch(url,{headers:{range:'bytes=0-1','if-range':'"old"'}});assert.equal(changed.status,200);assert.equal((await changed.arrayBuffer()).byteLength,data.length);
  await f.publish('empty',Buffer.alloc(0));const empty=await fetch(f.base+'/server/files/gcodes/empty.gcode');assert.equal(empty.status,200);assert.equal((await empty.arrayBuffer()).byteLength,0);
  for(const path of ['missing.gcode','binary.json','../binary.gcode','%2Fbinary.gcode'])assert.equal((await fetch(f.base+'/server/files/gcodes/'+path)).status,404);
  assert.equal((await fetch(url,{method:'POST'})).status,405);await until(()=>f.uploads.status.downloads===0);assert.equal(f.uploads.status.downloadSnapshots.reservedBytes,0);assert.equal(f.network.status.outputBufferedBytes,0);
 }finally{await f.close();}
});
test('authorization precedes lookup and is repeated with the immutable file identity',async()=>{
 const calls:Readonly<Record<string,Json>>[]=[];let deny=1;
 const f=await fixture({authorize:(method,params)=>{if(method==='server.files.download'){calls.push(params);if(deny===1||deny===2&&params.file_id)throw new ApiError(403,'Denied');}}});
 try{await f.publish('auth',Buffer.from('G1 X1\n'));const url=f.base+'/server/files/gcodes/auth.gcode';assert.equal((await fetch(url)).status,403);assert.equal(calls.length,1);deny=2;assert.equal((await fetch(url)).status,403);assert.equal(calls.length,3);assert.equal(calls[2].file_id,'auth');assert.equal(calls[2].filename,'模型.gcode');assert.equal(f.uploads.status.downloadSnapshots.reservations,0);deny=0;const ok=await fetch(url);assert.equal(ok.status,200);await ok.arrayBuffer();}finally{await f.close();}
});
test('changed receipt during authorization and corrupted content cannot produce a successful download',async()=>{
 let change=false;const f=await fixture({authorize:async(method,params)=>{if(method==='server.files.download'&&params.file_id&&change){change=false;await f.files.remove('file',signal());await f.publish('file',Buffer.from('G1 X2\n'));}}});
 try{const original=await f.publish('file',Buffer.from('G1 X1\n'));const url=f.base+'/server/files/gcodes/file.gcode';change=true;assert.equal((await fetch(url)).status,409);const record=await f.files.inspect('file');assert.notEqual(record.sha256,original.sha256);await chmod(join(f.dir,'files',record.sha256+'.gcode'),0o600);await writeFile(join(f.dir,'files',record.sha256+'.gcode'),'G1 X9\n');assert.equal((await fetch(url)).status,500);assert.equal(f.uploads.status.downloadSnapshots.reservations,0);}finally{await f.close();}
});
test('slow clients retain bounded download quota, preserve print capacity and release on shutdown',async()=>{
 const f=await fixture({maxDownloads:1});let paused:IncomingMessage|undefined;
 try{await f.publish('large',Buffer.alloc(16*1024**2,59));await f.publish('print',Buffer.from('G1 X1\n'));
  paused=await new Promise<IncomingMessage>((resolve,reject)=>{const request=httpRequest(f.base+'/server/files/gcodes/large.gcode',response=>{response.pause();response.on('error',()=>{});resolve(response);});request.on('error',reject);request.end();});
  await until(()=>f.uploads.status.downloadSnapshots.reservations===1);assert.equal(f.uploads.status.downloadSnapshots.reservedBytes,16*1024**2);assert.equal(f.network.status.outputBufferedBytes,3*65536);
  assert.equal((await fetch(f.base+'/server/files/gcodes/large.gcode')).status,429);
  const print=await f.files.acquire('print',signal());assert.equal(f.printBudget.status.reservations,1);const batch=(await print.next(signal()))!;assert.equal(batch.script,'G1 X1');await print.close();
  await f.uploads.close();await until(()=>f.network.status.outputBufferedBytes===0);assert.equal(f.uploads.status.downloads,0);assert.equal(f.uploads.status.downloadSnapshots.reservations,0);
 }finally{paused?.destroy();await f.close();}
});
test('snapshot and network budgets fail explicitly and held authorization is cancelled without late IO',async()=>{
 const f=await fixture({maxDownloadBytes:4096});try{await f.publish('big',Buffer.alloc(4097));assert.equal((await fetch(f.base+'/server/files/gcodes/big.gcode')).status,413);assert.equal(f.uploads.status.downloadSnapshots.reservations,0);}finally{await f.close();}
 const small=await fixture({maxOutputBytes:65536});try{await small.publish('small',Buffer.alloc(1));assert.equal((await fetch(small.base+'/server/files/gcodes/small.gcode')).status,429);}finally{await small.close();}
 const held=Promise.withResolvers<void>(),pending=await fixture({authorize:()=>held.promise});try{const request=fetch(pending.base+'/server/files/gcodes/absent.gcode');await until(()=>pending.uploads.status.authorizing===1);await pending.uploads.close();assert.equal((await request).status,503);held.resolve();await until(()=>pending.uploads.status.authorizing===0);assert.equal(pending.uploads.status.downloadSnapshots.reservations,0);}finally{held.resolve();await pending.close();}
});

test('native G-code and metadata thumbnail downloads coexist under the gcodes root',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'download-thumbnail-')),storage=await ThumbnailStorage.open(dir),metadata=new FileMetadataStore(),id=ThumbnailStorage.newId();let f:Awaited<ReturnType<typeof fixture>>|undefined;
 try{const bytes=await sharp({create:{width:16,height:16,channels:3,background:'#123456'}}).png().toBuffer();await publishThumbnailMetadata(storage,metadata,metadata.begin('part.gcode'),{},id,[{bytes,width:16,height:16,format:'png',miniature:false}],signal());f=await fixture({thumbnails:new ThumbnailDownloads(storage,metadata)});await f.publish('part',Buffer.from('G1 X1\n'));
  const gcode=await fetch(f.base+'/server/files/gcodes/part.gcode');assert.equal(gcode.status,200);assert.equal(await gcode.text(),'G1 X1\n');const thumbnail=await fetch(f.base+'/server/files/gcodes/.thumbs/'+id+'/0.png');assert.equal(thumbnail.status,200);assert.equal(thumbnail.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await thumbnail.arrayBuffer()),bytes);
 }finally{await f?.close();await storage.close();await rm(dir,{recursive:true,force:true});}
});
