import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm,utimes} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {FileListing,registerFileListing,type FileListingOptions} from '../src/moonraker/file-list.ts';
import {JsonRpcDispatcher,ApiError} from '../src/moonraker/rpc.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {MoonrakerNetwork} from '../src/moonraker/server.ts';
const signal=()=>new AbortController().signal;
async function fixture(extra:Partial<FileListingOptions>={}){
 const directory=await mkdtemp(join(tmpdir(),'file-list-')),root=join(directory,'gcodes');await mkdir(root);
 await mkdir(join(root,'parts'));await writeFile(join(root,'parts','b.GCODE'),'G1 X2\n');await writeFile(join(root,'A.g'),'G1 X1\n');await writeFile(join(root,'ignore.txt'),'text');
 for(const p of ['A.g','parts/b.GCODE'])await utimes(join(root,p),1700000000,1700000000.25);
 const files=await FileListing.open({roots:[{name:'gcodes',path:root,writable:true},{name:'config',path:root,writable:false}],...extra});
 return {directory,root,files,async close(){await files.close();await rm(directory,{recursive:true,force:true});}};
}
test('real directory listing returns sorted root-relative paths and current stat metadata',async()=>{
 const f=await fixture();try{
  assert.deepEqual(f.files.roots(),[{name:'gcodes',path:f.root,permissions:'rw'},{name:'config',path:f.root,permissions:'r'}]);
  assert.deepEqual(await f.files.list('gcodes',signal()),[{path:'A.g',modified:1700000000.25,size:6,permissions:'rw'},{path:'parts/b.GCODE',modified:1700000000.25,size:6,permissions:'rw'}]);
  assert.deepEqual((await f.files.list('config',signal())).map(v=>[v.path,v.permissions]),[['A.g','r'],['ignore.txt','r'],['parts/b.GCODE','r']]);
  await writeFile(join(f.root,'new.nc'),'M400\n');assert.equal((await f.files.list('gcodes',signal())).length,3);
  await assert.rejects(f.files.list('../gcodes',signal()),/invalid path/);
  assert.throws(()=>{(f.files.roots()[0] as any).path='/';});
 }finally{await f.close();}
});
test('directory aliases and symlink cycles are visited once; file links are read-only',async()=>{
 const f=await fixture();try{
  await symlink('..',join(f.root,'parts','loop'));await symlink('parts',join(f.root,'alias'));
  await symlink('A.g',join(f.root,'linked.gcode'));await symlink('absent',join(f.root,'dangling.gcode'));
  const list=await f.files.list('gcodes',signal());assert.equal(list.length,3);assert.equal(list.filter(v=>v.path.endsWith('b.GCODE')).length,1);assert.equal(list.find(v=>v.path==='linked.gcode')?.permissions,'r');
 }finally{await f.close();}
});
test('reserved directories are skipped, reserved files keep upstream permission metadata',async()=>{
 const f=await fixture();let files:FileListing|undefined;
 try{
  await mkdir(join(f.root,'.git'));await writeFile(join(f.root,'.git','hidden.gcode'),'secret');
  await mkdir(join(f.root,'private'));await writeFile(join(f.root,'private','secret.gcode'),'secret');
  await symlink('.git/hidden.gcode',join(f.root,'link.gcode'));
  files=await FileListing.open({roots:[{name:'gcodes',path:f.root,writable:true}],reserved:[{path:join(f.root,'private'),canRead:false},{path:join(f.root,'A.g'),canRead:false},{path:join(f.root,'parts'),canRead:true}]});
  const list=await files.list('gcodes',signal());assert.deepEqual(list.map(v=>[v.path,v.permissions]),[['A.g',''],['link.gcode',''],['parts/b.GCODE','r']]);
 }finally{await files?.close();await f.close();}
});
test('entry and output capacities reject oversized scans without partial responses',async()=>{
 for(const limits of [{maxFiles:1},{maxEntries:1},{maxOutputBytes:20}]){
  const f=await fixture(limits);try{await assert.rejects(f.files.list('gcodes',signal()),(e:any)=>e instanceof ApiError&&e.status===413);}finally{await f.close();}
 }
});
test('cancelled requests retain admission until acknowledged; close rejects outstanding reads',async()=>{
 const f=await fixture({maxPending:1}),controller=new AbortController();
 try{
  const first=f.files.list('gcodes',controller.signal),rejection=assert.rejects(first,/cancel scan/);controller.abort(new Error('cancel scan'));await rejection;
  await assert.rejects(f.files.list('gcodes',signal()),/queue is full/);
  while(f.files.pendingRequests)await new Promise(resolve=>setTimeout(resolve,1));
  const pending=f.files.list('gcodes',signal()),closed=assert.rejects(pending,/closed/);await f.files.close();await closed;
  await assert.rejects(f.files.list('gcodes',signal()),/closed/);
 }finally{await f.close();}
});
test('invalid roots fail startup and endpoint collision rolls back every registration',async()=>{
 await assert.rejects(FileListing.open({roots:[{name:'gcodes',path:'/',writable:true}]}),/Invalid file root/);
 await assert.rejects(FileListing.open({roots:[{name:'gcodes',path:'relative',writable:true}]}),/Invalid file roots/);
 const f=await fixture(),rpc=new JsonRpcDispatcher(),registry=new EndpointRegistry(rpc);
 try{const remove=registry.register({endpoint:'/server/files/list',methods:['GET']},()=>null);assert.throws(()=>registerFileListing(registry,f.files),/already/);assert.equal(rpc.has('server.files.roots'),false);remove();const detach=registerFileListing(registry,f.files);detach();detach();assert.equal(rpc.has('server.files.list'),false);}finally{await f.close();}
});
test('authenticated HTTP and WebSocket expose actual root and file list contracts',async()=>{
 const f=await fixture(),rpc=new JsonRpcDispatcher(),registry=new EndpointRegistry(rpc),detach=registerFileListing(registry,f.files);
 const network=new MoonrakerNetwork(rpc,{endpoints:registry,authorize(_method,params,{request}){if(request.headers['x-api-key']!=='key')throw new ApiError(401,'Unauthorized');if(params.root==='config')throw new ApiError(403,'Root forbidden');}});
 const address=await network.listen(),url=`http://127.0.0.1:${address.port}`;let ws:WebSocket|undefined;
 try{
  assert.equal((await fetch(url+'/server/files/list')).status,401);
  assert.equal((await fetch(url+'/server/files/list?root=config',{headers:{'x-api-key':'key'}})).status,403);
  const response=await fetch(url+'/server/files/list',{headers:{'x-api-key':'key'}});assert.equal(response.status,200);assert.deepEqual((await response.json() as any).result,await f.files.list('gcodes',signal()));
  ws=new WebSocket(url.replace('http:','ws:')+'/websocket',{headers:{'x-api-key':'key'}});await once(ws,'open');const received=once(ws,'message');ws.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'server.files.roots'}));assert.deepEqual(JSON.parse(String((await received)[0])).result,f.files.roots());
  const invalid=once(ws,'message');ws.send(JSON.stringify({jsonrpc:'2.0',id:2,method:'server.files.list',params:{root:123}}));assert.equal(JSON.parse(String((await invalid)[0])).error.code,400);
 }finally{ws?.terminate();await network.close();detach();await f.close();}
});
test('invalid UTF-8 filenames fail explicitly instead of disappearing from the list',async()=>{
 const f=await fixture();try{
  const path=Buffer.concat([Buffer.from(f.root+'/bad-'),Buffer.from([255]),Buffer.from('.gcode')]);await writeFile(path,'G1 X1\n');
  await assert.rejects(f.files.list('gcodes',signal()),/encoded data was not valid/);
  await rm(path);await writeFile(join(f.root,'valid-\ufffd.gcode'),'G1 X1\n');
  assert.ok((await f.files.list('gcodes',signal())).some(item=>item.path==='valid-\ufffd.gcode'));
 }finally{await f.close();}
});
