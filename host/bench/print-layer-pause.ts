import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,open,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {PrintLayerPause} from '../src/operations/print-layer-pause.ts';
const current=fileURLToPath(new URL('..',import.meta.url)),baseline=process.argv[2];
if(process.argv.length!==3||!baseline||!isAbsolute(baseline)||resolve(baseline)===resolve(current))throw new Error('Expected absolute independently frozen baseline host directory');
const paths=['gcode/dispatch.ts','gcode/file-execution.ts','gcode/file-reader.ts','gcode/print-layer-info.ts','operations/file-print-device.ts','operations/print.ts'];
const modules=async(root:string)=>Promise.all(paths.map(path=>import(pathToFileURL(join(root,'src',path)).href)));
const [oldModules,newModules]=await Promise.all([modules(baseline),modules(current)]),moves=10000,warmups=3,samples=11;
const limits={medianRatio:1.10,p95Ratio:1.15,slackMs:2};
const script=Array.from({length:moves},(_,i)=>(i%100===0?`SET_PRINT_STATS_INFO ${i===0?'TOTAL_LAYER=100 ':''}CURRENT_LAYER=${i/100}\n`:'')+`G1 X${i} F6000\n`).join('');
const directory=await mkdtemp(join(tmpdir(),'layer-pause-benchmark-')),path=join(directory,'input.gcode');await writeFile(path,script);
const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const timings:{baseline:number[];candidate:number[];ratios:number[]}={baseline:[],candidate:[],ratios:[]};
async function run(variant:'baseline'|'candidate'){
 const [{GCodeDispatch},{},{GCodeFileReader},{PrintLayerInfo},{FilePrintDevice},{PrintController}]=variant==='baseline'?oldModules:newModules;
 const seen:number[][]=[],layers=new PrintLayerInfo(),dispatch=new GCodeDispatch({output(){},shutdown(){}});layers.register(dispatch);dispatch.register('G1',(command:any)=>{seen.push([Number(command.params.X),Number(command.params.F)]);});
 let pauses=0,stops=0,finishes=0;
 const file=new FilePrintDevice({async prepare(request:any){layers.reset(request.requestId);dispatch.setReady(true);},async start(){},async pause(){pauses++;},async resume(){},async finish(){finishes++;},async stop(){stops++;}},dispatch,async()=>GCodeFileReader.adopt(await open(path,'r'),{batchLines:128}));
 const controller=new PrintController(file,{maxNozzle:300,maxBed:120}),policy=variant==='candidate'?new PrintLayerPause(controller,file,layers):undefined,abort=new AbortController();
 const changes=controller.watchState(abort.signal),completed=(async()=>{for await(const change of changes){if(change.state==='completed')return;if(change.state==='failed'||change.state==='cancelled')throw new Error('Unexpected benchmark outcome');}throw new Error('Incomplete benchmark');})();
 const start=performance.now();
 try{
  await controller.start({version:1,requestId:'bench',fileId:'file',nozzle:0,bed:0});await completed;const elapsed=performance.now()-start;
  assert.equal(seen.length,moves);for(let i=0;i<moves;i++)assert.deepEqual(seen[i],[i,6000]);assert.equal(pauses,0);assert.equal(stops,0);assert.equal(finishes,1);assert.equal(controller.state,'completed');assert.equal(layers.status.current_layer,99);
  return {elapsed,output:digest(JSON.stringify(seen)),state:controller.state,layer:layers.status};
 }finally{abort.abort();policy?.close();await controller.retire();}
}
try{
 for(let sample=0;sample<warmups+samples;sample++){
  const order=sample%2?['candidate','baseline'] as const:['baseline','candidate'] as const,results:Partial<Record<'baseline'|'candidate',Awaited<ReturnType<typeof run>>>>={};
  for(const variant of order)results[variant]=await run(variant);
  const old=results.baseline!,next=results.candidate!;assert.deepEqual({output:next.output,state:next.state,layer:next.layer},{output:old.output,state:old.state,layer:old.layer});
  if(sample>=warmups){timings.baseline.push(old.elapsed);timings.candidate.push(next.elapsed);timings.ratios.push(next.elapsed/old.elapsed);}
 }
 const sorted=(values:number[])=>[...values].sort((a,b)=>a-b),old=sorted(timings.baseline),next=sorted(timings.candidate),ratio=sorted(timings.ratios),hashes:Record<string,{baseline:string;candidate:string}>={};
 for(const path of paths)hashes[path]={baseline:digest(await readFile(join(baseline,'src',path))),candidate:digest(await readFile(join(current,'src',path)))};
 console.log(JSON.stringify({node:process.version,inputSha256:digest(script),moves,metadataCommands:100,warmups,samples,alternatingOrder:true,outputsExact:true,baseline:{path:baseline,medianMs:old[5],p95Ms:old[10]},candidate:{medianMs:next[5],p95Ms:next[10]},pairedMedianRatio:ratio[5],timings,limits,sourceHashes:hashes,scope:'Same 10000-command software file pump with and without the unarmed production layer policy; includes reader, parser, dispatch and controller completion. No UART, thermal hardware, target board or mixed API load; does not close the print-speed or G3 gate.'}));
 assert(next[5]<=old[5]*limits.medianRatio+limits.slackMs,'Unarmed file pump median regression');assert(next[10]<=old[10]*limits.p95Ratio+limits.slackMs,'Unarmed file pump P95 regression');
}finally{await rm(directory,{recursive:true,force:true});}
