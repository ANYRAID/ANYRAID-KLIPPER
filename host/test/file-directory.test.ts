import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm,statfs} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {FileListing,registerFileListing,type FileListingOptions} from '../src/moonraker/file-list.ts';
import {JsonRpcDispatcher,ApiError,type RpcContext} from '../src/moonraker/rpc.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
const signal=()=>new AbortController().signal;
async function fixture(extra:Partial<FileListingOptions>={}){
 const directory=await mkdtemp(join(tmpdir(),'file-dir-')),root=join(directory,'gcodes');await mkdir(root);await mkdir(join(root,'parts'));await mkdir(join(root,'.git'));await mkdir(join(root,'private'));
 await writeFile(join(root,'part.gcode'),'G1 X1\n');await writeFile(join(root,'readme.txt'),'text');await writeFile(join(root,'parts','other.GCO'),'G1 X2\n');await symlink('part.gcode',join(root,'link.gcode'));await symlink('missing',join(root,'broken'));
 const files=await FileListing.open({roots:[{name:'gcodes',path:root,writable:true},{name:'config',path:root,writable:false}],reserved:[{path:join(root,'private'),canRead:false}],...extra});
 return {root,files,async close(){await files.close();await rm(directory,{recursive:true,force:true});}};
}
test('directory lists one level including non-G-code files and reserved permission entries',async()=>{
 const f=await fixture();try{
  const {result}=await f.files.directory('/gcodes/',signal());
  assert.deepEqual(result.dirs.map(d=>d.dirname).sort(),['.git','parts','private']);assert.equal(result.dirs.find(d=>d.dirname==='private')!.permissions,'');
  assert.deepEqual(result.files.map(d=>d.filename).sort(),['link.gcode','part.gcode','readme.txt']);assert.equal(result.files.find(d=>d.filename==='link.gcode')!.permissions,'r');
  assert.deepEqual(result.root_info,{name:'gcodes',permissions:'rw'});
  const fs=await statfs(f.root,{bigint:true});assert.equal(result.disk_usage.total,Number(fs.blocks*fs.bsize));assert.ok(result.disk_usage.used>=0);assert.ok(result.disk_usage.free>=0);assert.ok(result.disk_usage.used+result.disk_usage.free<=result.disk_usage.total);
  const child=await f.files.directory('gcodes/unused/../parts',signal());assert.equal(child.relativePath,'parts');assert.deepEqual(child.result.files.map(f=>f.filename),['other.GCO']);
 }finally{await f.close();}
});
test('directory rejects invalid roots, non-directories and reserved paths including symlinks',async()=>{
 const f=await fixture();try{
  for(const path of ['../gcodes','gcodes/../../tmp','unknown','gcodes/missing','gcodes/part.gcode'])await assert.rejects(f.files.directory(path,signal()),(e:any)=>e.status===400);
  await symlink('private',join(f.root,'alias'));for(const path of ['gcodes/private','gcodes/alias','gcodes/.git'])await assert.rejects(f.files.directory(path,signal()),(e:any)=>e.status===403);
  const aborted=new AbortController();aborted.abort(new Error('cancel directory'));await assert.rejects(f.files.directory('gcodes',aborted.signal),/cancel directory/);
 }finally{await f.close();}
});
test('directory scan shares entry and output quotas',async()=>{
 for(const limits of [{maxFiles:1},{maxEntries:1},{maxOutputBytes:20}]){const f=await fixture(limits);try{await assert.rejects(f.files.directory('gcodes',signal()),(e:any)=>e.status===413);}finally{await f.close();}}
});
test('GET directory uses the upstream verb RPC name and merges only G-code metadata',async()=>{
 const f=await fixture(),rpc=new JsonRpcDispatcher(),registry=new EndpointRegistry(rpc),calls:string[]=[];
 const metadata={estimated_time:1.5,size:123,tags:{vendor:'test'}};registerFileListing(registry,f.files,path=>{calls.push(path);return metadata;});
 const authorized:string[]=[],context:RpcContext={transport:'http',signal:signal(),authorize(method){authorized.push(method);}};
 try{
  assert.ok(rpc.has('server.files.get_directory'));assert.equal(rpc.has('server.files.directory'),false);assert.equal(rpc.has('server.files.post_directory'),false);
  const value:any=await registry.invoke('/server/files/directory','GET',{path:'gcodes/parts',extended:'TRUE'},context);assert.equal(value.files[0].estimated_time,1.5);assert.equal(value.files[0].size,123);assert.deepEqual(calls,['parts/other.GCO']);value.files[0].tags.vendor='changed';assert.deepEqual(metadata,{estimated_time:1.5,size:123,tags:{vendor:'test'}});assert.deepEqual(authorized,['server.files.get_directory']);
  const response=JSON.parse((await rpc.dispatch(JSON.stringify({jsonrpc:'2.0',method:'server.files.get_directory',id:1}),{...context,transport:'websocket'}))!);assert.equal(response.result.root_info.name,'gcodes');
  await assert.rejects(registry.invoke('/server/files/directory','POST',{},context),(e:any)=>e.status===405);
  await assert.rejects(registry.invoke('/server/files/directory','GET',{extended:'maybe'},context),(e:any)=>e.status===400);
  await assert.rejects(registry.invoke('/server/files/directory','GET',{}, {...context,authorize(){throw new ApiError(403,'Denied');}}),/Denied/);
 }finally{await f.close();}
});
test('extended G-code query requires metadata ownership and merged output remains bounded',async()=>{
 const f=await fixture(),rpc=new JsonRpcDispatcher(),registry=new EndpointRegistry(rpc),context:RpcContext={transport:'http',signal:signal(),authorize(){}};
 try{
  const detach=registerFileListing(registry,f.files);await assert.rejects(registry.invoke('/server/files/directory','GET',{extended:true},context),/metadata provider/);
  assert.equal((await registry.invoke('/server/files/directory','GET',{path:'config',extended:true},context) as any).root_info.permissions,'r');detach();
  registerFileListing(registry,f.files,()=>({notes:'x'.repeat(1024**2)}));await assert.rejects(registry.invoke('/server/files/directory','GET',{extended:true},context));
 }finally{await f.close();}
});
