import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {monitorEventLoopDelay} from 'node:perf_hooks';
const baseline=process.env.ANYRAID_UPLOAD_BASELINE;
if(!baseline)throw Error('Set ANYRAID_UPLOAD_BASELINE to the unchanged baseline repository');
const current=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const baselineHashes={'native-print-uploads.ts':'e07525ba1cf9a196bd9b68ef16a4238e5f6dd3f25b2c07c3d1af9b37b1d03698','product-print-api.ts':'ce188cd6fcc1c52b05eaa27d5f5d240d014c6739a9d2240fcc9fa99b3a59e8dd','configured-server.ts':'f1b8413b903863bf9e22f3786679b0cf439d8ece35ce8499bcbb7f73a4b88b00'};
for(const [name,sha] of Object.entries(baselineHashes))assert.equal(createHash('sha256').update(await readFile(join(baseline,'host/src/moonraker',name))).digest('hex'),sha,'Baseline changed');
const sizes=[20123,256000,2000000],inputs=sizes.map(size=>Buffer.from('G1 X1\n'.repeat(Math.ceil(size/6))).subarray(0,size)),digests=inputs.map(bytes=>createHash('sha256').update(bytes).digest('hex'));
async function fixture(root:string){
 const load=async(path:string)=>import(pathToFileURL(join(root,'host/src',path+'.ts')).href);
 const [{PublishedPrintFiles},{NativePrintUploads},{MaintenanceGate},{PrintJournal},{PrintController},{ConfiguredMoonraker}]=await Promise.all(['storage/published-files','moonraker/native-print-uploads','operations/maintenance-gate','operations/print-journal','operations/print','moonraker/configured-server'].map(load));
 const dir=await mkdtemp(join(tmpdir(),'upload-print-bench-')),files=await PublishedPrintFiles.open(join(dir,'files')),gate=new MaintenanceGate(),journal=await PrintJournal.open({path:join(dir,'journal.db'),deviceId:'bench'}),uploads=new NativePrintUploads(files,gate,{stagingRoot:dir}),calls:string[]=[];
 const controller=new PrintController({async prepare(){calls.push('prepare');},async start(){calls.push('start');},async pause(){},async resume(){},async finish(){},async stop(){}},{maxNozzle:300,maxBed:120},{},{journal,maintenanceGate:gate}),path=join(dir,'moonraker.conf');await writeFile(path,'[server]\nhost=127.0.0.1\nport=0');
 const service=await ConfiguredMoonraker.load(path,{nativeUploads:uploads,productPrint:controller,maintenanceGate:gate,productPrintCompatibility:{async start(filename:string,signal:AbortSignal){return {fileId:await files.resolvePath(filename,signal),nozzle:0,bed:0};}},information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'bench',missingRequirements:[]},authorize(){return {username:'bench'};}}),address=await service.start(),base='http://127.0.0.1:'+address.port;
 return {controller,journal,calls,async sample(input:number,mode:'ordinary'|'separate'|'combined',name:string){
  const body=new FormData();body.append('file',new Blob([inputs[input]]),name);body.append('checksum',digests[input]);if(mode==='combined')body.append('print','true');
  const started=performance.now(),response=await fetch(base+'/server/files/upload',{method:'POST',body,signal:AbortSignal.timeout(5000)});assert.equal(response.status,200);const result=await response.json();assert.equal(result.file.sha256,digests[input]);assert.equal(result.file.size,sizes[input]);
  if(mode==='separate'){const print=await fetch(base+'/printer/print/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({filename:result.item.path}),signal:AbortSignal.timeout(5000)});assert.equal(print.status,200);assert.equal((await print.json()).result,'ok');}
  else assert.equal(result.print_started,mode==='combined');const elapsed=performance.now()-started;
  if(mode!=='ordinary'){const request=controller.currentRequest;assert.equal(request.fileId,result.file.id);if(mode==='combined')assert.equal(result.print_request_id,request.requestId);await controller.start(request);await controller.complete(request.requestId);assert.equal((await journal.get(request.requestId)).state,'completed');}
  return elapsed;
 },async close(){await service.close();await uploads.close();await files.close();await journal.close();await rm(dir,{recursive:true,force:true});}};
}
const stats=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b);return {medianMs:sorted[5],p95Ms:sorted[10],samplesMs:values};};
const original=await fixture(baseline),candidate=await fixture(current),owners=[original,candidate],ordinary=owners.map(()=>sizes.map(()=>[] as number[])),start=owners.map(()=>[] as number[]),eventLoop=monitorEventLoopDelay({resolution:1});eventLoop.enable();
try{
 for(let round=0;round<16;round++)for(let input=0;input<sizes.length;input++)for(const index of round%2?[1,0]:[0,1]){const elapsed=await owners[index].sample(input,'ordinary',`ordinary-${round}-${input}.gcode`);if(round>=5)ordinary[index][input].push(elapsed);}
 assert(owners.every(owner=>owner.calls.length===0),'Ordinary uploads started a print');
 for(let round=0;round<16;round++)for(const index of round%2?[1,0]:[0,1]){const elapsed=await owners[index].sample(0,index?'combined':'separate',`print-${round}.gcode`);if(round>=5)start[index].push(elapsed);}
 assert(owners.every(owner=>owner.calls.filter(call=>call==='start').length===16));eventLoop.disable();
 console.log(JSON.stringify({node:process.version,baselineHashes,warmups:5,retainedRounds:11,order:'Paired sequential, alternating original/candidate order by round',inputs:sizes.map((bytes,i)=>({bytes,sha256:digests[i]})),reports:ordinary.map((values,index)=>({variant:index?'candidate':'original',ordinaryUploads:values.map(stats),explicitPrintAdmission:stats(start[index])})),parentEventLoop:{p95Ms:eventLoop.percentile(95)/1e6,maxMs:eventLoop.max/1e6},scope:'Desktop HTTP publication plus software policy/authorization/durable admission only. No physical motion, file execution, mixed printing, target board, Python comparison or statistical non-regression claim.'},null,2));
}finally{eventLoop.disable();await candidate.close();await original.close();}
