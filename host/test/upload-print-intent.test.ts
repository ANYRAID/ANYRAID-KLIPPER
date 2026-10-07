import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {ConfiguredMoonraker,type ConfiguredServerOptions} from '../src/moonraker/configured-server.ts';
import {NativePrintUploads} from '../src/moonraker/native-print-uploads.ts';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {PrintController} from '../src/operations/print.ts';
import {FilePrintDevice} from '../src/operations/file-print-device.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
import {ApiError} from '../src/moonraker/rpc.ts';
import type {NativePrintCompatibility} from '../src/moonraker/product-print-api.ts';
const wait=async(check:()=>boolean)=>{const end=performance.now()+4000;while(!check()){assert(performance.now()<end,'Print intent condition timed out');await new Promise(r=>setTimeout(r,5));}};
const form=(print:string|undefined,name='控制验收 50%.gcode',data='G1 X1.000001\nG1 X2\n')=>{const body=new FormData();body.append('file',new Blob([data]),name);if(print!==undefined)body.append('print',print);return body;};
async function fixture(options:{authorize?:ConfiguredServerOptions['authorize'];policy?:NativePrintCompatibility;compatibility?:boolean}={}){
 const dir=await mkdtemp(join(tmpdir(),'upload-print-intent-')),files=await PublishedPrintFiles.open(join(dir,'files')),gate=new MaintenanceGate(),journal=await PrintJournal.open({path:join(dir,'journal.db'),deviceId:'printer'}),uploads=new NativePrintUploads(files,gate,{stagingRoot:dir}),finish=Promise.withResolvers<void>(),commands:string[]=[],calls:string[]=[];
 const dispatch=new GCodeDispatch({output(){},shutdown(){}});dispatch.register('G1',c=>{commands.push(c.rawParameters());});
 const device=new FilePrintDevice({async prepare(){calls.push('prepare');dispatch.setReady(true);},async start(){calls.push('start');},async pause(){},async resume(){},async finish(){await finish.promise;},async stop(){finish.resolve();}},dispatch,(id,signal)=>files.acquire(id,signal));
 const controller=new PrintController(device,{maxNozzle:300,maxBed:120},{},{journal,maintenanceGate:gate}),path=join(dir,'moonraker.conf');await writeFile(path,'[server]\nhost=127.0.0.1\nport=0');
 const policy=options.policy??{async start(filename,signal){return {fileId:await files.resolvePath(filename,signal),nozzle:0,bed:0};}};
 const service=await ConfiguredMoonraker.load(path,{nativeUploads:uploads,maintenanceGate:gate,productPrint:controller,productPrintCompatibility:options.compatibility===false?undefined:policy,information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'test',missingRequirements:[]},authorize:options.authorize??(()=>({username:'operator'}))});
 const address=await service.start(),base='http://127.0.0.1:'+address.port;
 return {dir,files,gate,journal,uploads,controller,commands,calls,service,base,finish,post:(body=form('true'),signal=AbortSignal.timeout(5000))=>fetch(base+'/server/files/upload',{method:'POST',body,signal}),async close(){finish.resolve();await service.close();await uploads.close();await files.close();await journal.close();await rm(dir,{recursive:true,force:true});}};
}
test('configured upload and print reauthorizes immutable identity after cleanup and executes sealed bytes once',async()=>{
 const identities:any[]=[];let f:Awaited<ReturnType<typeof fixture>>;
 f=await fixture({async authorize(method,params){if(method==='printer.print.start'){identities.push(params);assert.equal(f.gate.status.activities,0);assert.deepEqual((await readdir(f.dir)).filter(n=>n.startsWith('anyraid-upload-')),[]);}return {username:'operator'};}});
 try{
  const response=await f.post();assert.equal(response.status,201);const result=await response.json();assert.equal(result.print_started,true);assert.equal(result.print_queued,false);assert.equal(result.print_error,undefined);assert.deepEqual(result.result,resultWithoutAlias(result));
  assert.equal(response.headers.get('location'),f.base+'/server/files/gcodes/%E6%8E%A7%E5%88%B6%E9%AA%8C%E6%94%B6%2050%25.gcode');
  assert.match(result.print_request_id,/^upload-/);assert.equal(result.item.path,'控制验收 50%.gcode');assert.equal(result.file.sha256,createHash('sha256').update('G1 X1.000001\nG1 X2\n').digest('hex'));
  assert.equal(identities.length,1);assert.equal(identities[0].file_id,result.file.id);assert.equal(identities[0].filename,result.item.path);assert.equal(identities[0].request_id,result.print_request_id);assert.equal('queued_user' in identities[0],false);
  await wait(()=>f.commands.length===2);assert.deepEqual(f.commands,['X1.000001','X2']);assert.deepEqual(f.calls,['prepare','start']);assert.equal(f.controller.currentRequest!.fileId,result.file.id);assert.equal((await f.journal.get(result.print_request_id))?.request.fileId,result.file.id);
  f.finish.resolve();await wait(()=>f.controller.state==='completed');assert.equal((await f.journal.get(result.print_request_id))?.state,'completed');
 }finally{await f.close();}
});
function resultWithoutAlias(result:any){const {result:_,...value}=result;return value;}
for(const print of [undefined,'false','0',''])test('ordinary upload preserves zero print policy calls: '+String(print),async()=>{
 let policyCalls=0;const f=await fixture({policy:{async start(){policyCalls++;throw Error('Ordinary upload invoked print policy');}}});
 try{const response=await f.post(form(print));assert.equal(response.status,201);const result=await response.json();assert.equal(result.print_started,false);assert.equal(result.print_request_id,undefined);assert.equal(result.print_error,undefined);assert.equal(policyCalls,0);assert.equal(f.controller.state,'idle');assert.deepEqual(f.calls,[]);assert.equal(f.files.status.publishedFiles,1);}finally{await f.close();}
});
test('print denial preserves publication with an explicit failed start receipt and zero device effects',async()=>{
 const f=await fixture({authorize(method){if(method==='printer.print.start')throw new ApiError(403,'Print denied');return {username:'operator'};}});
 try{const response=await f.post();assert.equal(response.status,201);const result=await response.json();assert.equal(result.print_started,false);assert.deepEqual(result.print_error,{code:403,message:'Print denied'});assert.equal(response.headers.get('location'),f.base+'/server/files/gcodes/%E6%8E%A7%E5%88%B6%E9%AA%8C%E6%94%B6%2050%25.gcode');assert.equal(await (await fetch(response.headers.get('location')!)).text(),'G1 X1.000001\nG1 X2\n');assert.equal(result.print_queued,false);assert.equal((await f.files.inspect(result.file.id)).sha256,result.file.sha256);assert.equal(await f.journal.get(result.print_request_id),null);assert.equal(f.controller.state,'idle');assert.deepEqual(f.calls,[]);assert.equal(f.gate.status.activities,0);}finally{await f.close();}
});
test('upload denial does not publish or authorize printing',async()=>{
 let printCalls=0;const f=await fixture({authorize(method){if(method==='printer.print.start')printCalls++;throw new ApiError(401,'Upload denied');}});
 try{const response=await f.post();assert.equal(response.status,401);assert.equal(response.headers.get('location'),null);assert.equal(f.files.status.publishedFiles,0);assert.equal(printCalls,0);assert.deepEqual(f.calls,[]);}finally{await f.close();}
});
test('compatibility absence reports published file and unavailable print without replay',async()=>{
 const f=await fixture({compatibility:false});try{const response=await f.post();assert.equal(response.status,201);const result=await response.json();assert.equal(result.print_started,false);assert.equal(result.print_error.code,503);assert.equal((await f.files.inspect(result.file.id)).id,result.file.id);assert.equal(await f.journal.get(result.print_request_id),null);assert.deepEqual(f.calls,[]);}finally{await f.close();}
});
test('filename resolution cannot substitute another immutable file for the uploaded identity',async()=>{
 const f=await fixture({policy:{async start(){return {fileId:'other',nozzle:0,bed:0};}}});try{const response=await f.post();assert.equal(response.status,201);const result=await response.json();assert.equal(result.print_started,false);assert.deepEqual(result.print_error,{code:409,message:'Published file changed'});assert.equal(f.files.status.publishedFiles,1);assert.equal(await f.journal.get(result.print_request_id),null);assert.deepEqual(f.calls,[]);}finally{await f.close();}
});
test('busy printer keeps an unrelated upload but rejects a second print intent',async()=>{
 const f=await fixture();try{
  const first=await (await f.post()).json();assert.equal(first.print_started,true);await wait(()=>f.commands.length===2);
  const second=await (await f.post(form('true','second.gcode','G1 X9\n'))).json();assert.equal(second.print_started,false);assert.equal(second.print_error.code,409);assert.equal(f.controller.currentRequest!.requestId,first.print_request_id);assert.equal(await f.journal.get(second.print_request_id),null);assert.equal(f.files.status.publishedFiles,2);assert.deepEqual(f.commands,['X1.000001','X2']);assert.deepEqual(f.calls,['prepare','start']);
 }finally{await f.close();}
});
test('device retirement cancels held print authorization without late admission or publication rollback',async()=>{
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let authorizedId:string|undefined;
 const f=await fixture({async authorize(method,params){if(method==='printer.print.start'){authorizedId=String(params.request_id);entered.resolve();await release.promise;}return {username:'operator'};}});
 try{
  const pending=f.post().then(r=>r.status);await entered.promise;assert.equal(f.files.status.publishedFiles,1);assert.equal(f.gate.status.activities,0);
  const retired=f.service.retireNativePrinter();release.resolve();await retired;assert.equal(await pending,503);assert.equal(await f.journal.get(authorizedId!),null);assert.deepEqual(f.calls,[]);assert.equal(f.files.status.publishedFiles,1);assert.equal(f.uploads.status.pending,0);
 }finally{release.resolve();await f.close();}
});
test('disconnect during print authorization preserves upload and never admits the late result',async()=>{
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),abort=new AbortController();let requestId:string|undefined;
 const f=await fixture({async authorize(method,params){if(method==='printer.print.start'){requestId=String(params.request_id);entered.resolve();await release.promise;}return {username:'operator'};}});
 try{
  const pending=f.post(form('true'),abort.signal),cancelled=assert.rejects(pending,/abort/i);await entered.promise;abort.abort();await cancelled;
  await wait(()=>f.uploads.status.pending===0);assert.equal(f.files.status.publishedFiles,1);assert.equal(f.gate.status.activities,0);assert.equal(await f.journal.get(requestId!),null);
  const status=await (await fetch(f.base+'/printer/print/status')).json();assert.equal(status.result.pending_compatibility,1);assert.deepEqual(f.calls,[]);
  release.resolve();await wait(()=>f.controller.pendingDeviceActions===0);await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(await f.journal.get(requestId!),null);assert.deepEqual(f.calls,[]);assert.equal(f.controller.state,'idle');
 }finally{release.resolve();await f.close();}
});
