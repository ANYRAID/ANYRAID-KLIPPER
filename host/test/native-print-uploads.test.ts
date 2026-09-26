import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readdir,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {request as httpRequest} from 'node:http';
import {NativePrintUploads,registerNativeFileInfo} from '../src/moonraker/native-print-uploads.ts';
import {MoonrakerNetwork,type MoonrakerNetworkOptions} from '../src/moonraker/server.ts';
import {JsonRpcDispatcher,ApiError} from '../src/moonraker/rpc.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
import {PrintController} from '../src/operations/print.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {FilePrintDevice} from '../src/operations/file-print-device.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
const until=async(check:()=>boolean)=>{const end=Date.now()+4000;while(!check()){assert.ok(Date.now()<end,'Upload condition timed out');await new Promise(r=>setTimeout(r,5));}};
const multipart=(data:string|Uint8Array='G1 X1\n',fields:Record<string,string>={},name='part.gcode')=>{const form=new FormData();form.append('file',new Blob([typeof data==='string'?data:new Uint8Array(data)]),name);for(const [key,value] of Object.entries(fields))form.append(key,value);return form;};
async function fixture(options:{max?:number;authorize?:MoonrakerNetworkOptions['authorize']}={}){
 const dir=await mkdtemp(join(tmpdir(),'native-upload-test-')),gate=new MaintenanceGate(),files=await PublishedPrintFiles.open(join(dir,'files')),uploads=new NativePrintUploads(files,gate,{stagingRoot:dir,maxFileBytes:options.max??4*1024**2,maxUploads:1}),rpc=new JsonRpcDispatcher(),endpoints=new EndpointRegistry(rpc);registerNativeFileInfo(endpoints,uploads);
 const network=new MoonrakerNetwork(rpc,{endpoints,nativeUploads:uploads,authorize:options.authorize??(()=>{})}),address=await network.listen(),url=`http://127.0.0.1:${address.port}`;
 return {dir,gate,files,uploads,network,url,post:(body:FormData)=>fetch(url+'/server/files/upload',{method:'POST',body,signal:AbortSignal.timeout(5000)}),async clean(){await network.close();await uploads.close();await files.close();await rm(dir,{recursive:true,force:true});}};
}
const thumbnailBlock=(bytes:Buffer,width=80,height=40)=>{const data=bytes.toString('base64');return `; thumbnail_png begin ${width}x${height} ${data.length}\n; ${data}\n; thumbnail_png end\nG1 X1\n`;};
test('native thumbnail HTTP journey preserves bytes, conditional responses, per-file authorization and replacement revocation',async()=>{
 let denied=false;const calls:Record<string,unknown>[]=[],f=await fixture({authorize:(method,params)=>{if(method==='server.files.download'){calls.push({...params});if(denied&&params.file_id==='preview')throw new ApiError(403,'Denied preview');}}});
 try{
  const png=await sharp({create:{width:80,height:40,channels:3,background:'#123456'}}).png().toBuffer();
  assert.equal((await f.post(multipart(thumbnailBlock(png),{file_id:'preview'}))).status,200);
  const results=await Promise.all([0,1].map(async()=>{const response=await fetch(f.url+'/server/files/metadata?filename=preview.gcode');assert.equal(response.status,200);return (await response.json()).result;}));
  assert.deepEqual(results[0],results[1],'Concurrent extraction must not revoke the other response');
  assert.deepEqual(results[0].thumbnails.map((t:any)=>[t.width,t.height]),[[32,16],[80,40]]);
  const thumbs=(await (await fetch(f.url+'/server/files/thumbnails?filename=preview.gcode')).json()).result;
  assert.equal(thumbs[1].thumbnail_path,results[0].thumbnails[1].relative_path);
  const url=f.url+'/server/files/gcodes/'+thumbs[1].thumbnail_path,response=await fetch(url);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
  assert.equal(calls.at(-1)?.file_id,'preview');assert.equal(calls.at(-1)?.filename,'preview.gcode');
  const head=await fetch(url,{method:'HEAD'});assert.equal(head.status,200);assert.equal(Number(head.headers.get('content-length')),png.length);assert.equal((await head.arrayBuffer()).byteLength,0);
  assert.equal((await fetch(url,{headers:{'if-none-match':response.headers.get('etag')!}})).status,304);
  denied=true;assert.equal((await fetch(url)).status,403);assert.equal(f.network.status.bufferedBytes,0);denied=false;
  const signal=new AbortController().signal;await f.files.remove('preview',signal);
  assert.equal((await f.post(multipart('G1 X2\n',{file_id:'preview'}))).status,200);
  assert.equal((await fetch(url,{method:'HEAD'})).status,404);assert.equal(f.uploads.status.metadata.imageBytes,0);
  assert.deepEqual((await (await fetch(f.url+'/server/files/thumbnails?filename=preview.gcode')).json()).result,[]);
 }finally{await f.clean();}assert.equal(f.uploads.status.metadata.imageBundles,0);
});
test('malformed native thumbnail does not publish partial metadata or poison following extraction',async()=>{
 const f=await fixture();try{
  assert.equal((await f.post(multipart(thumbnailBlock(Buffer.from('invalid')),{file_id:'bad'}))).status,200);
  assert.equal((await fetch(f.url+'/server/files/metadata?filename=bad.gcode')).status,422);
  assert.equal(f.uploads.status.metadata.imageBytes,0);assert.equal(f.uploads.status.metadata.cache.entries,0);
  const png=await sharp({create:{width:80,height:40,channels:3,background:'red'}}).png().toBuffer();assert.equal((await f.post(multipart(thumbnailBlock(png),{file_id:'good'}))).status,200);
  const result=await fetch(f.url+'/server/files/thumbnails?filename=good.gcode');assert.equal(result.status,200);assert.equal((await result.json()).result.length,2);
 }finally{await f.clean();}
});
test('streaming native upload exceeds JSON limit and publishes exact immutable bytes with authorized receipt lookup',async()=>{
 const calls:{method:string;params:unknown}[]=[],f=await fixture({authorize:(method,params)=>{calls.push({method,params});}});
 try{const data=Buffer.alloc(2*1024**2,59),sha256=createHash('sha256').update(data).digest('hex'),response=await f.post(multipart(data,{file_id:'large',checksum:sha256,root:'gcodes'},'模型.gcode'));assert.equal(response.status,200);const result=(await response.json()).result;assert.deepEqual(result,{file:{version:1,id:'large',name:'模型.gcode',size:data.length,sha256},print_started:false,print_queued:false});assert.deepEqual(await readFile(join(f.dir,'files',sha256+'.gcode')),data);assert.equal((await (await fetch(f.url+'/printer/files/info?file_id=large')).json()).result.sha256,sha256);assert.deepEqual(calls.map(c=>c.method),['server.files.upload','server.files.upload','printer.files.info']);assert.deepEqual(calls[0].params,{});assert.equal((calls[1].params as any).size,data.length);assert.deepEqual((await readdir(f.dir)).sort(),['files']);assert.equal(f.network.status.bufferedBytes,0);
  assert.equal((await f.post(multipart('changed',{file_id:'large'}))).status,409);assert.deepEqual(await readFile(join(f.dir,'files',sha256+'.gcode')),data);assert.equal((await fetch(f.url+'/printer/files/info?file_id=missing')).status,404);
 }finally{await f.clean();}
});
test('multipart bounds, fields, paths, digest and auto-print fail without publication or staging leftovers',async()=>{
 const f=await fixture({max:100});try{
  assert.equal((await f.post(multipart('x'.repeat(100),{file_id:'exact'}))).status,200);
  const cases:[FormData,number][]=[[multipart('x'.repeat(101)),413],[multipart('G1',{print:'true'}),400],[multipart('G1',{path:'sub'}),400],[multipart('G1',{root:'config'}),400],[multipart('G1',{checksum:'0'.repeat(64)}),422],[multipart('G1',{},'../bad.gcode'),400],[multipart('G1',{},'bad.py'),400],[multipart('G1',{unexpected:'x'}),400],[multipart('G1',{file_id:'../id'}),400]];
  const duplicate=multipart();duplicate.append('root','gcodes');duplicate.append('root','gcodes');cases.push([duplicate,400]);const extra=multipart();extra.append('file',new Blob(['G1']),'other.gcode');cases.push([extra,400]);cases.push([new FormData(),400]);
  for(const [body,status] of cases){const response=await f.post(body);assert.equal(response.status,status,await response.text());assert.equal(f.files.status.publishedFiles,1);assert.deepEqual(await readdir(f.dir),['files']);}
  const truncated=await fetch(f.url+'/server/files/upload',{method:'POST',headers:{'content-type':'multipart/form-data; boundary=abc'},body:'--abc\r\nContent-Disposition: form-data; name="file"; filename="part.gcode"\r\n\r\nG1'});assert.equal(truncated.status,400);assert.deepEqual(await readdir(f.dir),['files']);
 }finally{await f.clean();}
});
test('upload authorizes before staging and after digest; maintenance blocks admission',async()=>{
 let stage=0;const f=await fixture({authorize:(_m,params)=>{stage++;if(stage===1||Object.hasOwn(params,'sha256'))throw new ApiError(403,'Denied');}});
 try{assert.equal((await f.post(multipart())).status,403);assert.equal(stage,1);assert.deepEqual(await readdir(f.dir),['files']);assert.equal((await f.post(multipart())).status,403);assert.equal(stage,3);assert.equal(f.files.status.publishedFiles,0);assert.deepEqual(await readdir(f.dir),['files']);const release=f.gate.acquire();try{assert.equal((await f.post(multipart())).status,409);assert.equal(stage,3);}finally{release();}}finally{await f.clean();}
});
test('held authorization has bounded admission and shutdown does not await an external policy',async()=>{
 const held=Promise.withResolvers<void>(),f=await fixture({authorize:()=>held.promise});
 try{const pending=f.post(multipart()).catch(()=>null);await until(()=>f.uploads.status.authorizing===1);assert.throws(()=>f.gate.acquire());assert.equal((await f.post(multipart())).status,429);await f.uploads.close();await pending;assert.equal(f.uploads.status.pending,0);assert.equal(f.uploads.status.authorizing,1);assert.deepEqual(await readdir(f.dir),['files']);held.resolve();await until(()=>f.uploads.status.authorizing===0);assert.equal(f.files.status.publishedFiles,0);}finally{held.resolve();await f.clean();}
});
test('client disconnect during multipart streaming drains staging and releases activity',async()=>{
 const f=await fixture();let req:ReturnType<typeof httpRequest>|undefined;try{
  req=httpRequest(f.url+'/server/files/upload',{method:'POST',headers:{'content-type':'multipart/form-data; boundary=abc'}});req.on('error',()=>{});req.write('--abc\r\nContent-Disposition: form-data; name="file"; filename="part.gcode"\r\n\r\n'+('G1 X1\n'.repeat(10000)));await until(()=>f.uploads.status.pending===1);req.destroy();await until(()=>f.uploads.status.pending===0);assert.equal(f.files.status.publishedFiles,0);assert.deepEqual(await readdir(f.dir),['files']);const release=f.gate.acquire();release();
 }finally{req?.destroy();await f.clean();}
});
test('configured native upload stays idle until durable HTTP start, then executes sealed file through EOF drain',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'upload-print-')),gate=new MaintenanceGate(),journal=await PrintJournal.open({path:join(dir,'journal.db'),deviceId:'printer'}),files=await PublishedPrintFiles.open(join(dir,'files')),uploads=new NativePrintUploads(files,gate,{stagingRoot:dir}),commands:string[]=[],drain=Promise.withResolvers<void>();let service:ConfiguredMoonraker|undefined;
 const dispatch=new GCodeDispatch({output(){},shutdown(){}});dispatch.register('G1',command=>{commands.push(command.rawParameters());});
 const device=new FilePrintDevice({async prepare(){dispatch.setReady(true);},async start(){},async pause(){},async resume(){},async finish(){await drain.promise;},async stop(){drain.resolve();}},dispatch,(id,signal)=>files.acquire(id,signal)),controller=new PrintController(device,{maxNozzle:300,maxBed:120},{},{journal,maintenanceGate:gate});
 try{const path=join(dir,'main.conf');await writeFile(path,'[server]\nhost=127.0.0.1\nport=0');const information={connected:false,state:'disconnected' as const,components:[],failedComponents:[],directories:[],warnings:[],version:'test',missingRequirements:[]};
  await assert.rejects(ConfiguredMoonraker.load(path,{nativeUploads:uploads,maintenanceGate:gate,information,authorize:()=>{}}),/Native uploads/);
  service=await ConfiguredMoonraker.load(path,{nativeUploads:uploads,productPrint:controller,maintenanceGate:gate,information,authorize:(_m,_p,ctx)=>{if(ctx.request.headers['x-api-key']!=='operator')throw new ApiError(401,'Denied');}});const address=await service.start(),url=`http://127.0.0.1:${address.port}`,headers={'x-api-key':'operator'};
  const uploaded=await fetch(url+'/server/files/upload',{method:'POST',headers,body:multipart('G1 X1.000001\nG1 X2\n',{file_id:'part'})});assert.equal(uploaded.status,200);assert.equal(controller.state,'idle');assert.deepEqual(commands,[]);assert.equal((await fetch(url+'/printer/files/info?file_id=part')).status,401);
  assert.equal((await fetch(url+'/server/files/list')).status,401);assert.equal((await fetch(url+'/server/files/directory')).status,401);assert.equal((await fetch(url+'/server/files/metadata?filename=part.gcode')).status,401);
  const catalog=await (await fetch(url+'/server/files/list',{headers})).json();assert.equal(catalog.result.length,1);assert.equal(catalog.result[0].name,'part.gcode');assert.equal(catalog.result[0].path,'part.gcode');
  const selected=catalog.result[0].file_id;assert.equal(selected,'part');
  const started=await fetch(url+'/printer/print/start',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({version:1,request_id:'job',file_id:selected,nozzle:0,bed:0,expires_at:Date.now()+60000})});assert.equal(started.status,200);await until(()=>controller.state==='finishing');assert.deepEqual(commands,['X1.000001','X2']);assert.notEqual((await journal.get('job'))?.state,'completed');drain.resolve();await until(()=>controller.state==='completed');assert.equal((await journal.get('job'))?.state,'completed');await service.close();assert.equal(uploads.status.closed,true);assert.equal(files.status.closed,false);assert.equal(gate.status.closed,true);
 }finally{drain.resolve();await service?.close();await uploads.close();await files.close();await journal.close();await rm(dir,{recursive:true,force:true});}
});
test('aborted authorization remains counted until actual settlement and cannot grow without bound',async()=>{
 const held=Promise.withResolvers<void>(),f=await fixture({authorize:()=>held.promise});try{
  for(let i=1;i<=2;i++){const abort=new AbortController(),pending=fetch(f.url+'/server/files/upload',{method:'POST',body:multipart(),signal:abort.signal}).catch(()=>null);await until(()=>f.uploads.status.authorizing===i);abort.abort();await pending;await until(()=>f.uploads.status.pending===0);}
  const encoded=new Request(f.url,{method:'POST',body:multipart()}),body=Buffer.from(await encoded.arrayBuffer());assert.equal((await fetch(f.url+'/server/files/upload',{method:'POST',headers:{'content-type':encoded.headers.get('content-type')!},body})).status,503);assert.equal(f.uploads.status.authorizing,2);assert.equal(f.files.status.publishedFiles,0);assert.deepEqual(await readdir(f.dir),['files']);held.resolve();await until(()=>f.uploads.status.authorizing===0);assert.equal((await f.post(multipart())).status,200);
 }finally{held.resolve();await f.clean();}
});
test('closing during final authorization prevents late publication and removes staged bytes',async()=>{
 const held=Promise.withResolvers<void>(),f=await fixture({authorize:(_m,p)=>Object.hasOwn(p,'sha256')?held.promise:undefined});try{
  const pending=f.post(multipart());await until(()=>f.uploads.status.authorizing===1);assert.ok((await readdir(f.dir)).some(name=>name.startsWith('anyraid-upload-')));await f.uploads.close();assert.equal((await pending).status,503);assert.deepEqual(await readdir(f.dir),['files']);held.resolve();await until(()=>f.uploads.status.authorizing===0);assert.equal(f.files.status.publishedFiles,0);
 }finally{held.resolve();await f.clean();}
});
test('chunked excess body and malformed headers reject without publication',async()=>{
 const f=await fixture({max:100});try{
  const response=await new Promise<number>((resolve,reject)=>{const req=httpRequest(f.url+'/server/files/upload',{method:'POST',headers:{'content-type':'multipart/form-data; boundary=abc'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode!));});req.on('error',reject);req.write('x'.repeat(70000));req.end();});assert.equal(response,413);
  for(const [url,type,body] of [[f.url+'/server/files/upload','multipart/form-data','x'],[f.url+'/server/files/upload?path=sub','multipart/form-data; boundary=abc','--abc--'],[f.url+'/server/files/upload','multipart/form-data; boundary=abc','--abc\r\nContent-Disposition: form-data; name="file"; filename="part.gcode"\r\nX-Test: '+('x'.repeat(17000))+'\r\n\r\nG1\r\n--abc--']]){const result=await fetch(url,{method:'POST',headers:{'content-type':type},body});assert.equal(result.status,400);}
  assert.equal(f.files.status.publishedFiles,0);assert.deepEqual(await readdir(f.dir),['files']);assert.equal(f.network.status.bufferedBytes,0);
 }finally{await f.clean();}
});

test('native catalog preserves duplicate names, stable receipt times and RPC parity across reopen',async()=>{
 const f=await fixture();let reopened:PublishedPrintFiles|undefined;
 try{
  assert.deepEqual((await (await fetch(f.url+'/server/files/list')).json()).result,[]);
  for(const [id,text] of [['z','G1 X2'],['a','G1 X1']])assert.equal((await f.post(multipart(text,{file_id:id},'同名.gcode'))).status,200);
  const result=(await (await fetch(f.url+'/server/files/list?root=gcodes')).json()).result;
  assert.deepEqual(result.map((entry:any)=>[entry.path,entry.file_id,entry.name]),[['a.gcode','a','同名.gcode'],['z.gcode','z','同名.gcode']]);
  for(const entry of result){assert(entry.modified>0&&entry.modified<=Date.now()/1000);assert.equal(entry.permissions,'r');assert.equal(entry.size,5);}
  assert.notEqual(result[0].sha256,result[1].sha256);
  const rpc=await fetch(f.url+'/server/jsonrpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'server.files.list',params:{}})});assert.deepEqual((await rpc.json()).result,result);
  assert.equal((await fetch(f.url+'/server/files/list?root=config')).status,404);assert.equal((await fetch(f.url+'/server/files/list?extra=x')).status,400);
  await f.files.close();reopened=await PublishedPrintFiles.open(join(f.dir,'files'));
  const catalog=await reopened.catalog(new AbortController().signal);assert.deepEqual(catalog.map(entry=>[entry.file.id,entry.modified]),result.map((entry:any)=>[entry.file_id,entry.modified]));
  await reopened.remove('a',new AbortController().signal);assert.deepEqual((await reopened.catalog(new AbortController().signal)).map(entry=>entry.file.id),['z']);
 }finally{await reopened?.close();await f.clean();}
});
test('native list registration rolls back info when the shared catalog route is already owned',async()=>{
 const f=await fixture();try{const rpc=new JsonRpcDispatcher(),registry=new EndpointRegistry(rpc);registry.register({endpoint:'/server/files/list',methods:['GET']},()=>[]);assert.throws(()=>registerNativeFileInfo(registry,f.uploads),/already registered/);assert.equal(registry.allowed('/printer/files/info'),undefined);assert.equal(rpc.has('printer.files.info'),false);assert.equal(rpc.has('server.files.list'),true);
  await f.uploads.close();assert.equal((await fetch(f.url+'/server/files/list')).status,503);
 }finally{await f.clean();}
});

test('native directory and scalar metadata bind the selected immutable file and survive source retirement',async()=>{
 const f=await fixture();try{
  const data='; generated by PrusaSlicer 2.8 on 2026-01-01 at 12:34:56\n; layer_height = .2\n; first_layer_height = 150%\nG1 X1\n';await f.post(multipart(data,{file_id:'meta'}));
  const url=f.url+'/server/files/metadata?filename=meta.gcode',response=await fetch(url);assert.equal(response.status,200);const metadata=(await response.json()).result;assert.equal(metadata.slicer,'PrusaSlicer');assert.equal(metadata.first_layer_height,.3);assert.equal(metadata.layer_height,.2);assert.equal(metadata.file_id,'meta');assert.equal(metadata.size,Buffer.byteLength(data));assert.equal(metadata.filename,'meta.gcode');
  const hot=(await (await fetch(url)).json()).result;assert.deepEqual(hot,metadata);assert.equal(f.uploads.status.metadata.cache.entries,1);assert.equal(f.uploads.status.metadata.snapshots.reservations,0);
  const directory=(await (await fetch(f.url+'/server/files/directory?path=gcodes&extended=true')).json()).result;assert.deepEqual(directory.dirs,[]);assert.equal(directory.files[0].filename,'meta.gcode');assert.equal(directory.files[0].layer_height,.2);assert.equal(directory.files[0].modified,metadata.modified);assert(directory.disk_usage.total>=directory.disk_usage.free);assert.equal(directory.root_info.name,'gcodes');
  const plain=(await (await fetch(f.url+'/server/files/directory')).json()).result;assert.equal(plain.files[0].layer_height,undefined);
  const rpc=await fetch(f.url+'/server/jsonrpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'server.files.get_directory',params:{extended:true}})});assert.equal((await rpc.json()).result.files[0].first_layer_height,.3);
  assert.equal((await fetch(f.url+'/server/files/directory?path=gcodes/../config')).status,404);assert.equal((await fetch(f.url+'/server/files/directory?extended=maybe')).status,400);assert.equal((await fetch(f.url+'/server/files/metadata?filename=../meta.gcode')).status,400);
  await f.files.remove('meta',new AbortController().signal);assert.equal((await fetch(url)).status,404);assert.equal((await (await fetch(f.url+'/server/files/directory?extended=true')).json()).result.files.length,0);
  await f.post(multipart(data.replace('= .2','= .4'),{file_id:'meta'}));const replacement=(await (await fetch(url)).json()).result;assert.equal(replacement.layer_height,.4);assert.notEqual(replacement.sha256,metadata.sha256);
  await f.uploads.close();assert.equal((await fetch(url)).status,503);
 }finally{await f.clean();}
});
