import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {buildMotan} from '../scripts/build-motan.ts';
import {managerFixture} from '../test/helpers/motan-manager-fixture.ts';
import {motanCsvReference,checkMotanCsvCapture,decodedMotanCsv} from '../test/helpers/motan-csv-reference.ts';
const cli=fileURLToPath(new URL('../../scripts/motan/data_export.ts',import.meta.url)),dir=await mkdtemp(join(tmpdir(),'motan-csv-bench-'));
const compiled=process.argv.includes('--compiled');
if(process.argv.slice(2).some(arg=>arg!=='--compiled'))throw new Error('Usage: motan-csv-export.ts [--compiled]');
let build:string|undefined,entry=cli;
const env:NodeJS.ProcessEnv={...process.env,PATH:'/no-external-programs',NODE_DISABLE_COMPILE_CACHE:'1'};delete env.NODE_COMPILE_CACHE;
try{
 if(compiled){const parent=fileURLToPath(new URL('../build/',import.meta.url));await mkdir(parent,{recursive:true});build=await mkdtemp(join(parent,'.csv-reference-bench-'));await buildMotan(join(build,'app'));entry=join(build,'app/scripts/motan/data_export.js');}
 for(const row of motanCsvReference().cases.filter(row=>row.id!=='cli')){
  const prefix=join(dir,row.id);await managerFixture(prefix,row.rounds,'corexy',{text:'逗号, "引号"\r\n换行',wide:9007199254740993123456789n,empty:null,yes:true});checkMotanCsvCapture(prefix,row);
  for(const typed of [false,true]){
   const args=[...(compiled?['--no-experimental-strip-types']:[]),entry,prefix,'-c',JSON.stringify(row.columns),'--segment-time',String(row.segment),'-d',String(row.duration),...(typed?['--preserve-number-types']:[])],samples:number[]=[];let output='';
   for(let i=0;i<9;i++){
    const start=performance.now(),current=execFileSync(process.execPath,args,{encoding:'utf8',env,maxBuffer:32*1024**2,timeout:30000}),elapsed=performance.now()-start;
    if(i)assert.equal(current,output);output=current;if(i>=2)samples.push(elapsed);
   }
   assert.deepEqual(decodedMotanCsv(output,row.numeric),row.decoded);samples.sort((a,b)=>a-b);
   console.log(JSON.stringify({node:process.version,compiled,id:row.id,typed,rows:row.decoded[1].length,bytes:Buffer.byteLength(output),medianMs:samples[3],p95Ms:samples[6],historicalPython:row.python,scope:'Full startup, analysis, CSV and stdout; compile cache disabled; fixed Python reference with exact binary64/text comparison outside timer and build excluded. No print throughput claim.'}));
  }
 }
}finally{await rm(dir,{recursive:true,force:true});if(build)await rm(build,{recursive:true,force:true});}
