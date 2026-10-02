// GPL-3.0-or-later. One-time local export path preflight, not print timing.
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {validateMotanOutput} from '../src/motan/output-path.ts';
const dir=await mkdtemp(join(tmpdir(),'motan-output-bench-')),samples:number[]=[];
try{
 for(let i=0;i<30;i++){
  const start=performance.now();
  for(let j=0;j<100;j++)await validateMotanOutput(join(dir,'log'),join(dir,'out.csv'));
  if(i>=5)samples.push((performance.now()-start)/100);
 }
 samples.sort((a,b)=>a-b);
 console.log(JSON.stringify({node:process.version,warmupBatches:5,measuredBatches:25,checksPerBatch:100,medianMsPerCheck:samples[12],p95MsPerCheck:samples[23],scope:'Three realpath calls per export, local temporary filesystem, warm directory cache; excludes analysis, encoding and writing. No Python or printer performance comparison.'},null,2));
}finally{await rm(dir,{recursive:true,force:true});}
