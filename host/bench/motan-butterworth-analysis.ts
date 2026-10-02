// Original Python results and timing are frozen; this benchmark runs Node only.
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {MotanLogManager} from '../src/motan/log-manager.ts';
import {MotanAnalyzer} from '../src/motan/analyzer.ts';
import {managerFixture} from '../test/helpers/motan-manager-fixture.ts';
import {analysisOracle} from '../test/helpers/motan-analysis-oracle.ts';

const stats=(ms:number[])=>{ms.sort((a,b)=>a-b);return {median:ms[3],p95:ms[6]};};
const dir=await mkdtemp(join(tmpdir(),'motan-butter-bench-')),prefix=join(dir,'log');
try {
 await managerFixture(prefix,10);
 for(const kind of ['lowpass','highpass','bandpass']){
  const mode='filtfilt';
  const names=[`sos(accelerometer(a,x),${mode},${kind},8,${kind==='bandpass'?'20,100':'50'})`];
  const reference=analysisOracle(prefix,names,.001,20,true),ms:number[]=[];
  let maxError=0;
  for(let run=0;run<9;run++){
   const start=performance.now(),manager=await MotanLogManager.open(prefix);let result;
   try{const analyzer=new MotanAnalyzer(manager,.001);for(const name of names)analyzer.addDataset(name);result=await analyzer.generate(20);}
   finally{await manager.close();}
   const elapsed=performance.now()-start;
   assert.deepEqual(Array.from(result.times),reference.times);
   for(const [name,values] of Object.entries(result.datasets))for(let i=0;i<values.length;i++)
    maxError=Math.max(maxError,Math.abs(values[i]-reference.data[name][i]));
   assert.ok(maxError<2e-10);
   if(run>=2)ms.push(elapsed);
  }
  console.log(JSON.stringify({kind,mode,node:process.version,samples:reference.times.length,
   nodeMs:stats(ms),historicalPythonMs:stats(reference.ms),maxAbsoluteError:maxError}));
 }
}finally{await rm(dir,{recursive:true,force:true});}
