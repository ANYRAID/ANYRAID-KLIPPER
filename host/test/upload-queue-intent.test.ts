import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ConfiguredMoonraker,type ConfiguredServerOptions} from '../src/moonraker/configured-server.ts';
import {NativePrintUploads} from '../src/moonraker/native-print-uploads.ts';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {PrintController} from '../src/operations/print.ts';
import {FilePrintDevice} from '../src/operations/file-print-device.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {ApiError} from '../src/moonraker/rpc.ts';
import {ProductPrintApi} from '../src/moonraker/product-print-api.ts';
const wait=async(check:()=>boolean)=>{const end=performance.now()+5000;while(!check()){assert(performance.now()<end,'Queue intent condition timed out');await new Promise(resolve=>setTimeout(resolve,5));}};
const form=(name:string,print=true,data='G1 X1.000001\nG1 X2\n')=>{const body=new FormData();body.append('file',new Blob([data]),name);body.append('print',String(print));return body;};
async function fixture(options:{queue?:boolean;authorized?:boolean;authorize?:ConfiguredServerOptions['authorize'];confirm?:boolean;root?:string;prepareFails?:boolean;holdPrinting?:boolean;automatic?:boolean}={}){
 const root=options.root??await mkdtemp(join(tmpdir(),'upload-queue-intent-')),path=join(root,'moonraker.conf'),database=await DatabaseStore.open({path:join(root,'api.db')}),journal=await PrintJournal.open({path:join(root,'prints.db'),deviceId:'upload-queue'}),files=await PublishedPrintFiles.open(join(root,'files')),gate=new MaintenanceGate(),processFiles=await NativePrintUploads.open(files,gate,{stagingRoot:root,metadataRoot:join(root,'metadata')}),deviceFiles=new NativePrintUploads(files,gate,{stagingRoot:root},processFiles),finish=Promise.withResolvers<void>(),printing=Promise.withResolvers<void>(),commands:string[]=[],starts:string[]=[];
 await writeFile(path,'[server]\nhost=127.0.0.1\nport=0\n[octoprint_compat]\n[file_manager]\nqueue_gcode_uploads='+String(options.queue!==false)+'\n[job_queue]\n'+(options.confirm?'job_transition_policy=operator_confirmation\n':'')+(options.automatic?'automatic_transition=true\n':''));
 const dispatch=new GCodeDispatch({output(){},shutdown(){}});dispatch.register('G1',async c=>{commands.push(c.rawParameters());if(options.holdPrinting&&commands.length===1)await printing.promise;});const device=new FilePrintDevice({async prepare(){if(options.prepareFails)throw Error('Synthetic device preparation failed after journal admission');dispatch.setReady(true);},async start(){starts.push('start');},async pause(){},async resume(){},async finish(){await finish.promise;},async stop(){finish.resolve();}},dispatch,(id,signal)=>files.acquire(id,signal));
 const controller=new PrintController(device,{maxNozzle:300,maxBed:120},{},{journal,maintenanceGate:gate});
 const common={database,productPrint:controller,maintenanceGate:gate,nativeUploads:deviceFiles,nativeProcessFiles:processFiles,nativeProcessHistory:journal,productPrintCompatibility:{async start(filename:string,signal:AbortSignal){return {fileId:await processFiles.resolveQueuedFile(filename,signal),nozzle:0,bed:0};}},information:{connected:false,state:'disconnected' as const,components:[],failedComponents:[],directories:[],warnings:[],version:'queue-intent',missingRequirements:[]}};
 const server=options.authorized?await ConfiguredMoonraker.loadAuthorized(path,{...common,authorization:{issuer:'https://queue-intent.invalid'}}):await ConfiguredMoonraker.load(path,{...common,authorize:options.authorize??(()=>({username:'operator'}))});const address=await server.start(),base='http://127.0.0.1:'+address.port,headers:Record<string,string>=options.authorized?{'x-api-key':server.authorization!.localApiKey()}:{};
 return {root,server,controller,journal,files,processFiles,deviceFiles,finish,printing,commands,starts,base,headers,post:(name:string,print=true,alias=false,signal=AbortSignal.timeout(8000))=>fetch(base+(alias?'/api/files/local':'/server/files/upload'),{method:'POST',headers,body:form(name,print),signal}),async status(){const r=await fetch(base+'/server/job_queue/status',{headers});assert.equal(r.status,200);return (await r.json()).result;},async close(removeRoot=true){printing.resolve();finish.resolve();await server.close();await deviceFiles.drain();await processFiles.drain();await files.close();await journal.close();await database.close();if(removeRoot)await rm(root,{recursive:true,force:true});}};
}
for(const alias of [false,true])test('explicit uploaded print joins the original queue when another sealed job owns the device: '+alias,async()=>{
 const f=await fixture();try{
  const first=await f.post('first.gcode');assert.equal(first.status,201);const started=await first.json();assert.equal(started.print_started,true);await wait(()=>f.commands.length===2);
  const second=await f.post('queued.gcode',true,alias);assert.equal(second.status,201);const queued=await second.json();assert.equal(queued.print_started,false);assert.equal(queued.print_queued,true);assert.equal(queued.print_error,undefined);assert.equal(f.controller.currentRequest!.requestId,started.print_request_id);assert.equal(f.starts.length,1);
  const status=await f.status();assert.equal(status.queued_jobs.length,1);assert.equal(status.queued_jobs[0].filename,'queued.gcode');assert.equal((await f.journal.historyList({limit:10})).length,1);assert.equal((await f.files.inspect(queued.file.id)).id,queued.file.id);
 }finally{await f.close();}
});
test('actual API-key queue intent persists exact file identity and needs fresh clearance after process restart',async()=>{
 const f=await fixture({authorized:true,confirm:true});let next:Awaited<ReturnType<typeof fixture>>|undefined;
 try{
  const first=await(await f.post('first.gcode')).json();await wait(()=>f.commands.length===2);const uploaded=await(await f.post('恢复后 50%.gcode',true,true)).json();assert.equal(uploaded.print_queued,true);const queued=await f.status();assert.equal(queued.queue_state,'paused');assert.equal(queued.queued_jobs.length,1);assert.equal(f.starts.length,1);
  await f.close(false);next=await fixture({root:f.root,authorized:true,confirm:true});const restored=await next.status();assert.equal(restored.queue_state,'paused');assert.equal(restored.queued_jobs[0].job_id,queued.queued_jobs[0].job_id);assert.equal(next.starts.length,0);assert.equal(next.commands.length,0);assert.equal(await next.processFiles.resolveQueuedFile('恢复后 50%.gcode',new AbortController().signal),uploaded.file.id);
  const headers={...next.headers,'content-type':'application/json'};const pending=await fetch(next.base+'/server/job_queue/start',{method:'POST',headers,body:'{"request_confirmation":true}'});assert.equal(pending.status,200);const transition=(await pending.json()).result.transition;assert(transition.state_token);assert.equal(next.starts.length,0);
  const accepted=await fetch(next.base+'/server/job_queue/start',{method:'POST',headers,body:JSON.stringify({transition_token:transition.state_token})});assert.equal(accepted.status,200);await accepted.arrayBuffer();await wait(()=>next!.commands.length===2);assert.equal(next.controller.currentRequest!.fileId,uploaded.file.id);assert.notEqual(next.controller.currentRequest!.requestId,first.print_request_id);next.finish.resolve();await wait(()=>next!.controller.state==='completed');assert.equal((await next.status()).queued_jobs.length,0);assert.deepEqual(next.commands,['X1.000001','X2']);assert.equal(next.starts.length,1);
 }finally{await next?.close();if(!next)await f.close();else await rm(f.root,{recursive:true,force:true});}
});
test('ordinary uploads and disabled queue policy never create queue members',async()=>{
 for(const queue of [false,true]){const f=await fixture({queue});try{await f.post('active.gcode');await wait(()=>f.commands.length===2);const stored=await(await f.post('stored.gcode',false,true)).json();assert.equal(stored.print_queued,false);assert.equal((await f.status()).queued_jobs.length,0);if(!queue){const denied=await(await f.post('busy.gcode',true,true)).json();assert.equal(denied.print_queued,false);assert.equal(denied.print_error.code,409);assert.equal((await f.status()).queued_jobs.length,0);}assert.equal(f.starts.length,1);}finally{await f.close();}}
});
test('queue or print authority denial preserves the file without adding or starting a job',async()=>{
 for(const denied of ['server.job_queue.post_job','printer.print.start']){
  const f=await fixture({authorize(method,params){if(method===denied&&(method==='server.job_queue.post_job'||params.filename==='denied.gcode'))throw new ApiError(403,'Denied queue intent');return {username:'operator'};}});try{await f.post('active.gcode');await wait(()=>f.commands.length===2);const response=await(await f.post('denied.gcode',true,true)).json();assert.equal(response.print_queued,false);assert.equal(response.print_error.code,403);assert.equal((await f.files.inspect(response.file.id)).id,response.file.id);assert.equal((await f.status()).queued_jobs.length,0);assert.equal(f.starts.length,1);}finally{await f.close();}
 }
});
test('a path replaced during queue authorization cannot redirect uploaded print intent',async()=>{
 let replace=true,f:Awaited<ReturnType<typeof fixture>>;f=await fixture({authorize:async(method,params)=>{if(method==='printer.print.start'&&params.filename==='queued.gcode'&&!Object.hasOwn(params,'version')&&replace){replace=false;assert.equal((await f.post('queued.gcode',false)).status,201);}return {username:'operator'};}});
 try{await f.post('active.gcode');await wait(()=>f.commands.length===2);const response=await(await f.post('queued.gcode',true,true)).json();assert.equal(response.print_queued,false);assert.equal(response.print_error.code,409);assert.match(response.print_error.message,/path changed/);assert.equal((await f.status()).queued_jobs.length,0);assert.equal(f.starts.length,1);}finally{await f.close();}
});
test('a failure after controller admission is never silently converted into another queued print',async t=>{
 const original=ProductPrintApi.prototype.call;
 t.mock.method(ProductPrintApi.prototype,'call',async function(this:ProductPrintApi,...args:Parameters<ProductPrintApi['call']>){const value=await original.apply(this,args);if(args[0]==='start')throw new ApiError(409,'Synthetic lost acknowledgement after real controller admission');return value;});
 const f=await fixture();try{const response=await(await f.post('uncertain.gcode',true,true)).json();assert.equal(response.print_started,false);assert.equal(response.print_queued,false);assert(response.print_error);const record=await f.journal.get(response.print_request_id);assert(record);assert.equal(record!.request.fileId,response.file.id);assert.equal((await f.status()).queued_jobs.length,0);await wait(()=>f.starts.length===1);assert.equal(f.starts.length,1);}finally{t.mock.restoreAll();await f.close();}
});
test('cancelled upload cannot commit a queue member after a held authorizer returns',async()=>{
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),abort=new AbortController(),f=await fixture({authorize:async method=>{if(method==='server.job_queue.post_job'){entered.resolve();await release.promise;}return {username:'operator'};}});
 try{await f.post('active.gcode');await wait(()=>f.commands.length===2);const outcome=f.post('cancelled.gcode',true,true,abort.signal).catch(error=>error);await entered.promise;abort.abort(new Error('Caller cancelled'));assert(await outcome instanceof Error);release.resolve();await new Promise(resolve=>setTimeout(resolve,20));assert.equal((await f.status()).queued_jobs.length,0);assert.equal(f.starts.length,1);}finally{release.resolve();await f.close();}
});
test('explicit OctoPrint selection preserves pinned identity in the same queue while busy or freshly offline',async()=>{
 for(const offline of [false,true]){const f=await fixture();try{if(!offline){await f.post('active.gcode');await wait(()=>f.commands.length===2);}const created=await f.post('selected.gcode',false,true);assert.equal(created.status,201);const file=await created.json();if(offline)await f.server.retireNativePrinter();const response=await fetch(created.headers.get('location')!,{method:'POST',headers:{...f.headers,'content-type':'application/json'},body:'{"command":"select","print":true}'});assert.equal(response.status,204);assert.equal((await f.status()).queued_jobs[0].filename,'selected.gcode');assert.equal(f.starts.length,offline?0:1);assert.equal(await f.processFiles.resolveQueuedFile('selected.gcode',new AbortController().signal),file.file.id);}finally{await f.close();}}
});
test('late hardware preparation failure remains the already admitted job and does not enqueue a replay',async()=>{
 const f=await fixture({prepareFails:true});try{const response=await(await f.post('late-failure.gcode',true,true)).json();assert.equal(response.print_started,true);assert.equal(response.print_queued,false);await wait(()=>f.controller.state==='failed');assert.equal((await f.journal.get(response.print_request_id))!.request.fileId,response.file.id);assert.equal((await f.status()).queued_jobs.length,0);assert.equal(f.starts.length,0);}finally{await f.close();}
});
test('selection admitted while offline cannot start a later live device generation',async()=>{
 const f=await fixture();try{
  const created=await f.post('offline-selection.gcode',false,true);assert.equal(created.status,201);
  const previous=new AbortController();previous.abort(new ApiError(503,'Previous device retired'));
  const signal=new AbortController().signal;
  await f.server.endpoints.invoke('/api/files/moonraker/gcodes/offline-selection.gcode','POST',{relative_path:'gcodes/offline-selection.gcode',command:'select',print:true},{transport:'http',signal,nativeGenerationSignal:previous.signal,nativeGenerationRetiredAtAdmission:true,user:{username:'operator'},authorize(){return {username:'operator'};}});
  assert.equal(f.starts.length,0);assert.equal(f.controller.state,'idle');assert.equal((await f.status()).queued_jobs[0].filename,'offline-selection.gcode');assert.equal((await f.journal.historyList({limit:10})).length,0);
 }finally{await f.close();}
});
test('uploaded automatic continuation still requires a fresh operator clearance after exact durable completion',async()=>{
 const f=await fixture({authorized:true,confirm:true,automatic:true,holdPrinting:true});try{
  const first=await(await f.post('active.gcode')).json();await wait(()=>f.commands.length===1&&f.controller.state==='printing');assert.equal(f.controller.state,'printing');const queued=await(await f.post('next.gcode',true,true)).json();assert.equal(queued.print_queued,true,JSON.stringify({error:queued.print_error,state:f.controller.state}));assert.equal((await f.status()).queue_state,'ready');assert.equal(f.starts.length,1);
  f.printing.resolve();f.finish.resolve();await wait(()=>f.controller.state==='completed');const end=performance.now()+5000;let status=await f.status();while(!status.transition){assert(performance.now()<end,'Missing completion clearance');await new Promise(resolve=>setTimeout(resolve,5));status=await f.status();}assert.equal(status.transition.phase,'awaiting_confirmation');assert.equal(f.starts.length,1);assert.equal(f.controller.currentRequest!.requestId,first.print_request_id);
  const headers={...f.headers,'content-type':'application/json'},response=await fetch(f.base+'/server/job_queue/start',{method:'POST',headers,body:JSON.stringify({transition_token:status.transition.state_token})});assert.equal(response.status,200);await response.arrayBuffer();await wait(()=>f.starts.length===2&&f.controller.state==='completed');assert.equal(f.controller.currentRequest!.fileId,queued.file.id);assert.equal((await f.status()).queued_jobs.length,0);assert.deepEqual(f.commands,['X1.000001','X2','X1.000001','X2']);
 }finally{await f.close();}
});
