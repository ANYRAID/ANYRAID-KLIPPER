import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import {statfsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {monitorEventLoopDelay,performance} from 'node:perf_hooks';
import {verifyProductBundle} from '../src/runtime/product-service-unit.ts';

// Both variants execute installed production JS. Driver setup, hashing and
// FormData construction are outside timing. Run after print-load acceptance.
const [baselineInput,candidateInput]=process.argv.slice(2);
if(!baselineInput||!candidateInput)throw new Error('Expected baseline and candidate compiled bundles');
const bundles=await Promise.all([baselineInput,candidateInput].map(p=>verifyProductBundle(resolve(p))));
const benchRoot=resolve(process.env.FILE_MUTATION_BENCH_ROOT??'host/build/file-mutation-bench');
await mkdir(benchRoot,{recursive:true});const root=await mkdtemp(join(benchRoot,'paired-'));
const data=Buffer.alloc(64*1024,59),sha256=createHash('sha256').update(data).digest('hex');
const owners:any[]=[],samples=[{upload:[] as number[],remove:[] as number[],directory:[] as number[]},{upload:[] as number[],remove:[] as number[],directory:[] as number[]}];
const delay=monitorEventLoopDelay({resolution:1});
try{
 for(const [index,bundle] of bundles.entries()){
  const load=(p:string)=>import(pathToFileURL(join(bundle,'host/src',p+'.js')).href);
  const [{NativePrintUploads,registerNativeFileInfo},{PublishedPrintFiles},{MaintenanceGate},{PrintController},{MoonrakerNetwork},{JsonRpcDispatcher},{EndpointRegistry}]=await Promise.all([
   load('moonraker/native-print-uploads'),load('storage/published-files'),load('operations/maintenance-gate'),load('operations/print'),load('moonraker/server'),load('moonraker/rpc'),load('moonraker/endpoints'),
  ]);
  const dir=join(root,String(index));await mkdir(dir);
  const gate=new MaintenanceGate(),files=await PublishedPrintFiles.open(join(dir,'files'));
  const uploads=new NativePrintUploads(files,gate,{stagingRoot:root}),rpc=new JsonRpcDispatcher(),endpoints=new EndpointRegistry(rpc);
  const controller=new PrintController({async prepare(){},async start(){},async pause(){},async resume(){},async finish(){},async stop(){}},{maxNozzle:300,maxBed:120},{},{maintenanceGate:gate});
  uploads.bindPrintController(controller);registerNativeFileInfo(endpoints,uploads);
  const network=new MoonrakerNetwork(rpc,{endpoints,nativeUploads:uploads,authorize(){}});
  const owner={files,uploads,controller,network,bundle,url:'',sequence:0};owners.push(owner);
  const address=await network.listen();owner.url='http://127.0.0.1:'+address.port;
 }
 async function sample(index:number,record:boolean){
  const owner=owners[index],id='paired-'+owner.sequence++,form=new FormData();form.append('file',new Blob([data]),id+'.gcode');form.append('file_id',id);form.append('path','');
  const start=performance.now(),uploaded=await fetch(owner.url+'/server/files/upload',{method:'POST',body:form});assert.equal(uploaded.status,200,await uploaded.clone().text());const upload=(await uploaded.json() as any).result;const uploadMs=performance.now()-start;
  assert.equal(upload.file.sha256,sha256);assert.equal(upload.file.size,data.length);
  for(let query=0;query<8;query++){
   const began=performance.now(),response=await fetch(owner.url+'/server/files/directory?extended=true');assert.equal(response.status,200);const directory=(await response.json() as any).result;const elapsed=performance.now()-began;assert.equal(directory.files.length,1);assert.equal(directory.files[0].file_id,id);if(record)samples[index].directory.push(elapsed);
  }
  const before=performance.now(),removed=await fetch(owner.url+'/server/files/gcodes/'+id+'.gcode',{method:'DELETE'});assert.equal(removed.status,200,await removed.clone().text());assert.equal((await removed.json() as any).result.action,'delete_file');const removeMs=performance.now()-before;
  assert.equal(owner.uploads.status.pending,0);assert.equal(owner.controller.state,'idle');if(record){samples[index].upload.push(uploadMs);samples[index].remove.push(removeMs);}
 }
 for(let warm=0;warm<3;warm++)for(const index of [0,1])await sample(index,false);
 delay.enable();await new Promise(resolve=>setTimeout(resolve,5));delay.reset();
 const order=[0,1,1,0,1,0,0,1];for(const index of order)for(let run=0;run<8;run++)await sample(index,true);
 delay.disable();const stats=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b);return {samples:sorted.length,medianMs:sorted[Math.floor(sorted.length*.5)],p95Ms:sorted[Math.floor(sorted.length*.95)],p99Ms:sorted[Math.floor(sorted.length*.99)]};};
 const results=samples.map(s=>({upload:stats(s.upload),remove:stats(s.remove),directory:stats(s.directory)}));
 const identities=await Promise.all(bundles.map(async path=>({path,manifestSha256:createHash('sha256').update(await readFile(join(path,'build-info.json'))).digest('hex')})));
 for(const bundle of bundles)await verifyProductBundle(bundle);
 const loop={p99Ms:delay.percentile(99)/1e6,maxMs:delay.max/1e6};assert(loop.p99Ms<50);assert(loop.maxMs<100);
 console.log(JSON.stringify({node:process.version,filesystemMagic:statfsSync(root).type,inputBytes:data.length,inputSha256:sha256,warmups:3,order,identities,results,medianCandidateBaselineRatios:Object.fromEntries((['upload','remove','directory'] as const).map(key=>[key,results[1][key].medianMs/results[0][key].medianMs])),loop,scope:'Paired loopback HTTP on the same real workspace filesystem, compiled production JS and independent installed dependencies. Includes real staging/publication/deletion durability and client work. Complements concurrent print acceptance; not target-board, Python comparison or physical printer proof.'},null,2));
}finally{
 delay.disable();for(const owner of owners){await owner.network.close();await owner.controller.retire();await owner.uploads.close();await owner.files.close();}await rm(root,{recursive:true,force:true});
}
