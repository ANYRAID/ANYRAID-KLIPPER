import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {FileMetadataStore,registerFileMetadata,thumbnailPath} from '../src/moonraker/file-metadata.ts';
import {FileListing,registerFileListing} from '../src/moonraker/file-list.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher,ApiError} from '../src/moonraker/rpc.ts';
import {MoonrakerNetwork} from '../src/moonraker/server.ts';
test('metadata snapshots isolate producers and return immutable nested metadata',()=>{
 const store=new FileMetadataStore(),input={filename:'wrong',estimated_time:20,thumbnails:[{relative_path:'.thumbs/x.png',width:32}]};
 assert.equal(store.commit(store.begin('folder/part.gcode'),input),true);input.estimated_time=999;input.thumbnails[0].width=99;
 assert.equal(store.metadata('folder/part.gcode').filename,'folder/part.gcode');assert.equal(store.metadata('folder/part.gcode').estimated_time,20);
 assert.throws(()=>{(store.peek('folder/part.gcode')!.thumbnails as any)[0].width=99;});
 const thumbs=store.thumbnails('folder/part.gcode') as any[];assert.deepEqual(thumbs,[{width:32,thumbnail_path:'folder/.thumbs/x.png'}]);thumbs[0].width=123;
 assert.equal((store.thumbnails('folder/part.gcode')[0] as any).width,32);assert.equal((store.peek('folder/part.gcode')!.thumbnails as any)[0].relative_path,'.thumbs/x.png');
});
test('superseded, foreign, consumed and failed scan tickets cannot overwrite newer metadata',()=>{
 const store=new FileMetadataStore(),first=store.begin('part.gcode'),second=store.begin('part.gcode');
 assert.equal(store.commit(first,{size:1}),false);assert.equal(store.fail(first),false);assert.equal(store.commit({...second},{size:1}),false);
 assert.equal(store.commit(second,{size:2}),true);assert.equal(store.commit(second,{size:3}),false);
 const third=store.begin('part.gcode');assert.equal(store.peek('part.gcode'),undefined);assert.equal(store.fail(third),true);assert.equal(store.commit(third,{size:4}),false);assert.equal(store.status.bytes,0);
 const stale=store.begin('part.gcode');store.clear();assert.equal(store.commit(stale,{size:5}),false);
});
test('metadata capacities count pending names and reject oversized replacements atomically',()=>{
 const store=new FileMetadataStore({maxRecords:1,maxBytes:60,maxRecordBytes:40}),ticket=store.begin('part.gcode');
 assert.equal(store.status.bytes,10);assert.throws(()=>store.begin('other.gcode'),/capacity/);assert.throws(()=>store.commit(ticket,{notes:'x'.repeat(41)}),/limit/);assert.equal(store.status.bytes,10);assert.equal(store.peek('part.gcode'),undefined);
 assert.equal(store.commit(ticket,{size:6}),true);assert.equal(store.status.bytes,20);store.invalidate('part.gcode');assert.equal(store.status.bytes,0);
 const bytes=new FileMetadataStore({maxBytes:15});const pending=bytes.begin('file.g');assert.throws(()=>bytes.commit(pending,{size:12345}),/capacity/);assert.equal(bytes.status.bytes,6);bytes.fail(pending);assert.equal(bytes.status.bytes,0);
 for(const name of ['','/absolute','a/../b','a//b','./a','a\0'])assert.throws(()=>store.begin(name),/filename/);
});
test('thumbnail paths preserve pathlib lexical dot-dot and absolute path behavior',()=>{
 for(const [file,relative,expected] of [['file.gcode','x.png','x.png'],['a/b/file.gcode','../.thumbs/x.png','a/b/../.thumbs/x.png'],['a/file.gcode','/images/x.png','/images/x.png'],['a/file.gcode','','a'],['file.gcode','','.'],['//share/f.g','x.png','//share/x.png'],['a/f.g','///x//./y','/x/y']])assert.equal(thumbnailPath(file,relative),expected);
 const store=new FileMetadataStore();store.commit(store.begin('file.gcode'),{thumbnails:[{width:1},{relative_path:null,thumbnail_path:'kept'}]});assert.deepEqual(store.thumbnails('file.gcode'),[{width:1},{thumbnail_path:'kept'}]);assert.deepEqual(store.thumbnails('missing'),[]);assert.throws(()=>store.metadata('missing'),(e:any)=>e.status===404);
});
test('thumbnail expansion and malformed metadata cannot bypass bounds',()=>{
 const store=new FileMetadataStore(),name='a/'.repeat(2040)+'x.g';store.commit(store.begin(name),{thumbnails:Array.from({length:256},()=>({relative_path:'x.png'}))});assert.throws(()=>store.thumbnails(name),(e:any)=>e.status===413);
 const ticket=store.begin('bad.gcode');for(const value of [{thumbnails:null},{thumbnails:[null]},{thumbnails:[{relative_path:3}]},{thumbnails:Array(257).fill({})},{size:NaN}])assert.throws(()=>store.commit(ticket,value as any));assert.equal(store.peek('bad.gcode'),undefined);
});
test('metadata endpoint registration rolls back on collision and detaches twice safely',()=>{
 const rpc=new JsonRpcDispatcher(),registry=new EndpointRegistry(rpc),store=new FileMetadataStore(),remove=registry.register({endpoint:'/server/files/thumbnails',methods:['GET']},()=>[]);
 assert.throws(()=>registerFileMetadata(registry,store),/already/);assert.equal(rpc.has('server.files.metadata'),false);remove();const detach=registerFileMetadata(registry,store);detach();detach();assert.equal(rpc.has('server.files.thumbnails'),false);
});
test('real HTTP, WebSocket and extended directory share the same metadata owner',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'metadata-network-')),root=join(dir,'gcodes');await mkdir(root);await writeFile(join(root,'part.gcode'),'G1 X1\n');
 const store=new FileMetadataStore();store.commit(store.begin('part.gcode'),{size:6,estimated_time:1.25,thumbnails:[{relative_path:'.thumbs/part.png',width:16}]});
 const files=await FileListing.open({roots:[{name:'gcodes',path:root,writable:true}]}),rpc=new JsonRpcDispatcher(),registry=new EndpointRegistry(rpc);registerFileListing(registry,files,path=>store.peek(path));registerFileMetadata(registry,store);
 const network=new MoonrakerNetwork(rpc,{endpoints:registry,authorize(_m,_p,{request}){if(request.headers['x-api-key']!=='key')throw new ApiError(401,'Unauthorized');}});const address=await network.listen(),url=`http://127.0.0.1:${address.port}`;let ws:WebSocket|undefined;
 try{
  assert.equal((await fetch(url+'/server/files/metadata?filename=part.gcode')).status,401);
  const request=(path:string)=>fetch(url+path,{headers:{'x-api-key':'key'}});
  const response=await request('/server/files/metadata?filename=part.gcode');assert.equal((await response.json() as any).result.estimated_time,1.25);
  assert.equal((await request('/server/files/metadata')).status,400);assert.equal((await request('/server/files/metadata?filename=missing')).status,404);
  const directory=await request('/server/files/directory?extended=true');assert.equal((await directory.json() as any).result.files[0].estimated_time,1.25);
  ws=new WebSocket(url.replace('http:','ws:')+'/websocket',{headers:{'x-api-key':'key'}});await once(ws,'open');const received=once(ws,'message');ws.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'server.files.thumbnails',params:{filename:'part.gcode'}}));assert.deepEqual(JSON.parse(String((await received)[0])).result,[{width:16,thumbnail_path:'.thumbs/part.png'}]);
  store.invalidate('part.gcode');assert.equal((await request('/server/files/metadata?filename=part.gcode')).status,404);
 }finally{ws?.terminate();await network.close();await files.close();await rm(dir,{recursive:true,force:true});}
});
