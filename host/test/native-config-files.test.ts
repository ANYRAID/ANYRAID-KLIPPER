import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {NativeConfigFiles} from '../src/moonraker/native-config-files.ts';
import {ApiError,type RpcContext} from '../src/moonraker/rpc.ts';
import {JsonRpcDispatcher} from '../src/moonraker/rpc.ts';
import {MoonrakerNetwork} from '../src/moonraker/server.ts';
const signal=()=>new AbortController().signal;
const context=():RpcContext=>({transport:'http',signal:signal(),authorize(){}});
async function fixture(options:Partial<Parameters<typeof NativeConfigFiles.open>[0]>={}){
 const dir=await mkdtemp('/tmp/native-config-'),root=join(dir,'config');await mkdir(join(root,'parts'),{recursive:true});await mkdir(join(root,'.git'));await mkdir(join(root,'private'));
 await writeFile(join(root,'printer.cfg'),'[include parts/axis.cfg]\n');await writeFile(join(root,'parts','axis.cfg'),'[printer]\nkinematics: cartesian\n');await writeFile(join(root,'private','key'),'private');await writeFile(join(root,'.git','config'),'git');await writeFile(join(dir,'outside'),'outside');
 const files=await NativeConfigFiles.open({root,reserved:['private'],...options});
 return {dir,root,files,async close(){await files.close();await rm(dir,{recursive:true,force:true});}};
}
async function download(files:NativeConfigFiles,name:string,ctx=context()){
 let bytes=Buffer.alloc(0);await files.download('/server/files/config/'+name,ctx,async(file,s)=>{const chunks:Buffer[]=[];for await(const chunk of file.reader.chunks(s))chunks.push(chunk);bytes=Buffer.concat(chunks);assert.equal(file.size,bytes.length);});return bytes.toString('utf8');
}
test('real config/include listing and binary snapshot remain pinned through replacement of the root path',async()=>{
 const f=await fixture();try{
  assert.equal(f.files.root().permissions,'r');assert(f.files.contains(join(f.root,'printer.cfg')));assert(!f.files.contains(join(f.dir,'outside')));
  const list=await f.files.list({root:'config'},signal()) as any[];assert.deepEqual(list.map(file=>file.path),['parts/axis.cfg','printer.cfg']);
  const directory=await f.files.directory({path:'config',extended:'TRUE'},signal()) as any;assert.equal(directory.root_info.permissions,'r');assert.equal(directory.dirs.find((dir:any)=>dir.dirname==='private').permissions,'');
  await rename(f.root,join(f.dir,'original'));await mkdir(f.root);await writeFile(join(f.root,'printer.cfg'),'replacement');
  assert.equal(await download(f.files,'printer.cfg'),'[include parts/axis.cfg]\n');assert.deepEqual((await f.files.list({root:'config'},signal()) as any[]).map(file=>file.path),['parts/axis.cfg','printer.cfg']);
  await f.files.download('/server/files/config/parts/axis.cfg',context(),async(file,s)=>{await writeFile(join(f.dir,'original','parts','axis.cfg'),'changed');const chunks:Buffer[]=[];for await(const chunk of file.reader.chunks(s))chunks.push(chunk);assert.equal(Buffer.concat(chunks).toString(),'[printer]\nkinematics: cartesian\n');});
  assert.equal(f.files.status.snapshots.reservations,0);
 }finally{await f.close();}
});
test('config reads deny unauthenticated, reserved, traversal and symlink sources; listings exclude symlink trees',async()=>{
 const f=await fixture();try{
  await symlink('../outside',join(f.root,'leak'));await symlink(f.dir,join(f.root,'alias'));
  assert.equal((await f.files.list({root:'config'},signal()) as any[]).some(file=>file.path==='leak'||file.path.startsWith('alias/')),false);
  for(const [path,status] of [['leak',404],['alias/outside',404],['%2e%2e/outside',400],['private/key',403],['.git/config',403],['%00',400]] as const)await assert.rejects(download(f.files,path),(e:any)=>e.status===status,path);
  await assert.rejects(download(f.files,'printer.cfg',{...context(),authorize(){throw new ApiError(401,'Unauthorized');}}),(e:any)=>e.status===401);
  for(const path of ['config/alias','config/private','config/../config'])await assert.rejects(f.files.directory({path},signal()));
  const directory=await f.files.directory({path:'config'},signal()) as any;assert(!directory.files.some((file:any)=>file.filename==='leak'));assert(!directory.dirs.some((dir:any)=>dir.dirname==='alias'));
 }finally{await f.close();}
});
test('bounded config downloads retain capacity until ignored authorization cancellation really settles',async()=>{
 const f=await fixture({maxDownloads:1,maxFileBytes:32}),entered=Promise.withResolvers<void>(),released=Promise.withResolvers<void>();let used=false;
 try{
  await writeFile(join(f.root,'large.cfg'),'x'.repeat(33));await assert.rejects(download(f.files,'large.cfg'),(e:any)=>e.status===413);
  const pending=f.files.download('/server/files/config/printer.cfg',{...context(),authorize(){entered.resolve();return released.promise;}},async()=>{used=true;});void pending.catch(()=>{});await entered.promise;
  await assert.rejects(download(f.files,'printer.cfg'),(e:any)=>e.status===429);
  let closed=false;const closing=f.files.close().then(()=>{closed=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);released.resolve();await assert.rejects(pending,(e:any)=>e.status===503);await closing;assert.equal(used,false);assert.equal(f.files.status.pending,0);assert.equal(f.files.status.snapshots.reservations,0);
 }finally{released.resolve();await f.close();}
});
test('descriptor-root startup is explicit and failed roots do not silently expose a parent',async()=>{
 const dir=await mkdtemp('/tmp/native-config-invalid-');try{
  await mkdir(join(dir,'config'));await symlink('config',join(dir,'link'));
  for(const root of ['/',dir+'/missing',dir+'/link'])await assert.rejects(NativeConfigFiles.open({root}));
  await assert.rejects(NativeConfigFiles.open({root:join(dir,'config'),reserved:['../outside']}));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('authenticated config HTTP preserves exact bytes, HEAD, ETag and byte ranges without enabling mutation',async()=>{
 const f=await fixture(),network=new MoonrakerNetwork(new JsonRpcDispatcher(),{configFiles:f.files,authorize(_method,_params,{request}){if(request.headers['x-api-key']!=='config-key')throw new ApiError(401,'Unauthorized');}});
 try{
  const address=await network.listen(),url=`http://127.0.0.1:${address.port}/server/files/config/printer.cfg`,headers={'x-api-key':'config-key'},text='[include parts/axis.cfg]\n';
  assert.equal((await fetch(url)).status,401);const response=await fetch(url,{headers});assert.equal(response.status,200);assert.equal(await response.text(),text);const etag=response.headers.get('etag')!;assert.match(etag,/^"[a-f0-9]{64}"$/);
  const head=await fetch(url,{headers,method:'HEAD'});assert.equal(head.status,200);assert.equal(head.headers.get('content-length'),String(Buffer.byteLength(text)));assert.equal(await head.text(),'');
  const cached=await fetch(url,{headers:{...headers,'if-none-match':etag}});assert.equal(cached.status,304);assert.equal(await cached.text(),'');
  const range=await fetch(url,{headers:{...headers,range:'bytes=0-7','if-range':etag}});assert.equal(range.status,206);assert.equal(await range.text(),text.slice(0,8));
  assert.equal((await fetch(url,{headers:{...headers,range:'bytes=1000-1001'}})).status,416);
  assert.equal((await fetch(url,{headers,method:'DELETE'})).status,405);assert.equal((await fetch(url,{headers,method:'POST'})).status,405);
  await writeFile(join(f.root,'中文.cfg'),'\ufeff[printer]\n');const named=await fetch(url.replace('printer.cfg',encodeURIComponent('中文.cfg')),{headers});assert.equal(named.status,200);assert(named.headers.get('content-disposition')!.includes(encodeURIComponent('中文.cfg')));assert.equal(Buffer.from(await named.arrayBuffer()).toString(),'\ufeff[printer]\n');
  assert.equal(f.files.status.snapshots.reservations,0);
 }finally{await network.close();await f.close();}
});
