import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir,cpus} from 'node:os';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import reference from '../contracts/firmware-conversion-reference.json' with {type:'json'};
const root=fileURLToPath(new URL('../../',import.meta.url)),dir=mkdtempSync(join(tmpdir(),'anyraid-firmware-bench-')),sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const timings=[];
try{
 for(const kind of ['mks_robin','chitu']){
  const input=join(dir,'input name.bin'),output=join(dir,'node.bin');
  const run=()=>{const p=spawnSync(process.execPath,[root+`scripts/update_${kind}.mts`,input,output],{env:{...process.env,PATH:'/no-programs',NODE_PATH:'',NODE_OPTIONS:''},encoding:'utf8',timeout:30000});if(p.error||p.status!==0)throw new Error(p.error?.message??p.stderr??'Converter failed');return p.stdout;};
  for(const sample of reference.fixtures.filter(f=>f.kind===kind)){
   const bytes=Buffer.alloc(sample.size);for(let i=0;i<bytes.length;i++)bytes[i]=(i*73+(i>>>8)*31)&255;assert.equal(sha(bytes),sample.inputSHA256);writeFileSync(input,bytes);assert.equal(run(),sample.stdout);const encoded=readFileSync(output);assert.equal(encoded.length,sample.outputSize);assert.equal(sha(encoded),sample.outputSHA256,kind+' '+sample.size);
  }
  for(let i=0;i<3;i++)run();const times:number[]=[];for(let i=0;i<11;i++){const start=performance.now();run();times.push(performance.now()-start);}times.sort((a,b)=>a-b);timings.push({kind,size:1048576,nodeMedianMs:times[5],nodeP95Ms:times[10]});
 }
}finally{rmSync(dir,{recursive:true,force:true});}
console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,fixtures:reference.fixtures.length,sourceCommit:reference.sourceCommit,sha256SizeAndStdoutMatch:true,pythonRequired:false,warmups:3,samples:11,scope:'Cold converter process plus file IO; reference data frozen from original Python, no Python or git executed',timings},null,2));
