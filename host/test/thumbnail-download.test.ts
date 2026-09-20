import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import sharp from 'sharp';
import {ThumbnailDownloads} from '../src/moonraker/thumbnail-download.ts';
import {ThumbnailStorage,publishThumbnailMetadata} from '../src/moonraker/thumbnail-storage.ts';
import {FileMetadataStore} from '../src/moonraker/file-metadata.ts';
import {MoonrakerNetwork} from '../src/moonraker/server.ts';
import {JsonRpcDispatcher,ApiError} from '../src/moonraker/rpc.ts';
const signal=new AbortController().signal;
async function fixture(options:{maxOutputBytes?:number;requestTimeoutMs?:number}={}){
 const dir=await mkdtemp(join(tmpdir(),'thumbnail-http-')),storage=await ThumbnailStorage.open(dir),metadata=new FileMetadataStore(),id=ThumbnailStorage.newId();
 const bytes=await sharp({create:{width:64,height:64,channels:3,background:'#123456'}}).png().toBuffer();
 await publishThumbnailMetadata(storage,metadata,metadata.begin('层/part.gcode'),{},id,[{bytes,width:64,height:64,format:'png',miniature:false}],signal);
 const auth:{filename?:unknown}[]=[],network=new MoonrakerNetwork(new JsonRpcDispatcher(),{...options,thumbnails:new ThumbnailDownloads(storage,metadata),authorize(_method,params,{request}){auth.push(params);if(request.headers['x-api-key']!=='key')throw new ApiError(401,'Unauthorized');if(params.filename&&request.headers['x-deny-file'])throw new ApiError(403,'Forbidden');}});
 const address=await network.listen(),base=`http://127.0.0.1:${address.port}`,path='/server/files/gcodes/'+encodeURI(`层/.thumbs/${id}/0.png`);
 return {storage,metadata,bytes,id,auth,network,base,path,get:(suffix=path,init:RequestInit={})=>fetch(base+suffix,{...init,headers:{'x-api-key':'key',...init.headers}}),close:async()=>{await network.close();await storage.close();await rm(dir,{recursive:true,force:true});}};
}
test('thumbnail GET authenticates source, sends exact bytes, HEAD and conditional cache responses',async()=>{
 const f=await fixture();try{
  assert.equal((await fetch(f.base+f.path)).status,401);assert.equal((await f.get(f.path,{headers:{'x-deny-file':'1'}})).status,403);
  const reply=await f.get();assert.equal(reply.status,200);assert.equal(reply.headers.get('content-type'),'image/png');assert.equal(reply.headers.get('content-length'),String(f.bytes.length));assert.deepEqual(Buffer.from(await reply.arrayBuffer()),f.bytes);assert.ok(f.auth.some(p=>p.filename==='层/part.gcode'));
  const head=await f.get(f.path,{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.headers.get('content-length'),String(f.bytes.length));assert.equal((await head.arrayBuffer()).byteLength,0);
  const conditional=await f.get(f.path,{headers:{'if-none-match':`"other", W/${reply.headers.get('etag')}`}});assert.equal(conditional.status,304);assert.equal((await conditional.arrayBuffer()).byteLength,0);
  const conditionalHead=await f.get(f.path,{method:'HEAD',headers:{'if-none-match':reply.headers.get('etag')!}});assert.equal(conditionalHead.status,304);assert.equal((await conditionalHead.arrayBuffer()).byteLength,0);
  assert.equal((await f.get(f.path,{method:'POST'})).status,405);assert.equal((await f.get(f.path,{headers:{origin:'https://untrusted.invalid'}})).status,403);
  f.metadata.invalidate('层/part.gcode');assert.equal((await f.get()).status,404);assert.equal((await f.get(f.path,{headers:{'if-none-match':'*'}})).status,404);
 }finally{await f.close();}
});
test('thumbnail index revokes replaced references and rejects ambiguity, foreign paths and malformed URLs',async()=>{
 const f=await fixture();try{
  for(const path of [f.path.replace('/0.png','/1.png'),f.path.replace('/0.png','/0.jpg'),f.path.replace('%E5%B1%82/','other/'),f.path.replace('/0.png','/00.png')])assert.equal((await f.get(path)).status,404);
  for(const path of [f.path.replace('/0.png','/%2e%2e%2f0.png'),f.path+'%ZZ',f.path.replace('/0.png','/%00.png')])assert.equal((await f.get(path)).status,400);
  const snapshot=f.metadata.peek('层/part.gcode')!;f.metadata.commit(f.metadata.begin('层/other.gcode'),snapshot);assert.equal((await f.get()).status,404);f.metadata.invalidate('层/other.gcode');assert.equal((await f.get()).status,200);
  const ticket=f.metadata.begin('层/part.gcode');assert.equal((await f.get()).status,404);f.metadata.commit(ticket,snapshot);assert.equal((await f.get()).status,200);f.metadata.clear();assert.equal((await f.get()).status,404);
 }finally{await f.close();}
});
test('response quota rejects before materializing image and HEAD remains available',async()=>{
 const f=await fixture({maxOutputBytes:1});try{assert.equal((await f.get()).status,429);assert.equal(f.storage.status.cachedBundles,0);assert.equal((await f.get(f.path,{method:'HEAD'})).status,200);assert.equal(f.network.status.outputBufferedBytes,0);}finally{await f.close();}
});
test('metadata invalidation during authorization and read cannot serve stale data',async()=>{
 const f=await fixture();try{
  const downloads=new ThumbnailDownloads(f.storage,f.metadata);const path=decodeURI(f.path);
  await assert.rejects(downloads.resolve(path,{transport:'http',signal,authorize:async(_m,p)=>{if(p.filename)f.metadata.invalidate('层/part.gcode');}}), (e:any)=>e.status===404);
  const value=await f.storage.inspect(f.id,signal);f.metadata.commit(f.metadata.begin('层/part.gcode'),{thumbnails:value.thumbnails});
  const download=await downloads.resolve(path,{transport:'http',signal,authorize:async()=>{}});const pending=download.read();f.metadata.invalidate('层/part.gcode');await assert.rejects(pending,(e:any)=>e.status===404);
 }finally{await f.close();}
});
test('slow HTTP reader retains output quota until disconnect and cancellation releases it',async()=>{
 const f=await fixture({maxOutputBytes:8*1024**2,requestTimeoutMs:5000});let req:ReturnType<typeof httpRequest>|undefined;
 try{
  // Storage accepts validated processor output; transport fixture is opaque and
  // intentionally large to exceed loopback socket buffering deterministically.
  const id=ThumbnailStorage.newId(),bytes=Buffer.alloc(8*1024**2,7);
  await publishThumbnailMetadata(f.storage,f.metadata,f.metadata.begin('large.gcode'),{},id,[{bytes,width:2048,height:2048,format:'png',miniature:false}],signal);
  const path=`/server/files/gcodes/.thumbs/${id}/0.png`;
  const response=await new Promise<import('node:http').IncomingMessage>((resolve,reject)=>{req=httpRequest(f.base+path,{headers:{'x-api-key':'key'}},resolve);req.on('error',reject);req.end();});response.pause();
  await delay(50);assert.equal(f.network.status.outputBufferedBytes,bytes.length);assert.equal((await f.get(path)).status,429);
  response.destroy();req?.destroy();for(let i=0;i<100&&f.network.status.outputBufferedBytes;i++)await delay(10);
  assert.equal(f.network.status.outputBufferedBytes,0);assert.equal((await f.get()).status,200);
 }finally{req?.destroy();await f.close();}
});
test('underdeclared metadata cannot allocate a response beyond its reservation',async()=>{
 const f=await fixture();try{
  await assert.rejects(f.storage.read(f.id,0,signal,1),/read limit/);
  const value=await f.storage.inspect(f.id,signal);f.metadata.commit(f.metadata.begin('层/part.gcode'),{thumbnails:value.thumbnails.map(item=>({...item,size:1}))});
  assert.equal((await f.get()).status,500);assert.equal(f.network.status.outputBufferedBytes,0);
 }finally{await f.close();}
});
