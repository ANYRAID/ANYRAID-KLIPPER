import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const sample=process.argv.includes('--sample');
if(sample){
 const begin=performance.now();
 const {createNativeProductHostFactory}=await import('../src/runtime/native-product-machine.ts');
 const {ProductHostControl}=await import('../src/runtime/product-host-control.ts');
 const root=await mkdtemp(join(tmpdir(),'native-process-components-')),dataPath=join(root,'private');await mkdir(dataPath);
 const configuration=join(root,'moonraker.conf'),manifest=join(root,'machine.json');
 await writeFile(configuration,'[server]\nhost=127.0.0.1\nport=0');await writeFile(join(dataPath,'moonraker.secrets'),'{"marker":"private benchmark generation"}');
 await writeFile(manifest,JSON.stringify({version:1,deviceId:'bench',printerConfig:join(root,'printer.cfg'),moonrakerConfig:configuration,journalPath:join(root,'jobs.db'),mcus:{mcu:{transport:'pipe'}},machine:{enableLeadTime:.001,fanMinimumScheduleTime:.001},print:{motorCompletion:'hold',startupHoming:{mode:'home',axes:[0,1,2]},parking:{parkXY:[0,0],retract:0,lift:0,travelSpeed:10,liftSpeed:10,retractSpeed:10}},limits:{maxNozzle:300,maxBed:130}}));
 const control=new ProductHostControl(),factory=createNativeProductHostFactory(manifest,{...{dataPath},filesRoot:join(root,'files'),metadataRoot:join(root,'metadata'),async createProcess(){return {server:{information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'bench',missingRequirements:[]},authorize(_method,_params,context){assert.equal(context.request.headers['x-api-key'],'benchmark');},authorizeNotification(){}},async release(){}};},async createAdapter(){throw Error('Benchmark cannot acquire a device');}});
 let server:Awaited<ReturnType<NonNullable<typeof factory.bootstrap>>>['server']|undefined;
 try{
  server=(await factory.bootstrap!(new AbortController().signal,control)).server;const address=await server.start(),startupMs=performance.now()-begin,base=`http://127.0.0.1:${address.port}`;
  await rm(configuration);await rm(join(dataPath,'moonraker.secrets'));
  const queryBegin=performance.now();for(let index=0;index<200;index++){const response=await fetch(base+'/server/info',{headers:{'x-api-key':'benchmark'}});assert.equal(response.status,200);const value=await response.json() as any;assert.equal(value.result.klippy_connected,false);assert.equal(value.result.klippy_state,'disconnected');}
  console.log(JSON.stringify({node:process.version,startupMs,queriesMs:performance.now()-queryBegin,queries:200,templatesLoaded:!!server.templates}));
 }finally{await server?.close();await factory.close!();await control.close();await rm(root,{recursive:true,force:true});}
}else{
 const reference=JSON.parse(await readFile(new URL('../contracts/native-process-components-reference.json',import.meta.url),'utf8'));
 const samples:{node:string;startupMs:number;queriesMs:number;queries:number;templatesLoaded:boolean}[]=[];for(let run=0;run<14;run++){
  const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--sample'],{encoding:'utf8',timeout:15000,env:{...process.env,TMPDIR:tmpdir(),NODE_DISABLE_COMPILE_CACHE:'1'}});
  assert.equal(child.status,0,child.stderr);samples.push(JSON.parse(child.stdout));
 }
 const results=Object.fromEntries((['startupMs','queriesMs'] as const).map(key=>{const ordered=samples.slice(3).map(value=>value[key]).sort((a,b)=>a-b),median=ordered[5];return [key,{median,ratio:median/reference.medians[key],limit:reference.maxRatio,passed:median/reference.medians[key]<=reference.maxRatio}];}));
 console.log(JSON.stringify({node:process.version,warmups:3,samples,results,scope:'Cold Node import, native process bootstrap/listen and 200 localhost metadata queries in fresh processes. No device acquisition, hardware printing, full fresh Rust build or target-board claim.'},null,2));
 assert(samples.every(value=>value.templatesLoaded),'Product process must own its template generation');assert(Object.values(results).every(value=>value.passed),'Process component performance budget exceeded');
}
