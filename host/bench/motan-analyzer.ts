// Original Python results and timing are frozen; this benchmark runs Node only.
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {MotanLogManager} from '../src/motan/log-manager.ts';
import {MotanAnalyzer} from '../src/motan/analyzer.ts';
import {managerFixture} from '../test/helpers/motan-manager-fixture.ts';
import {analysisOracle,analysisNames} from '../test/helpers/motan-analysis-oracle.ts';
const stats=(ms:number[])=>{ms.sort((a,b)=>a-b);return {median:ms[3],p95:ms[6]};},dir=await mkdtemp(join(tmpdir(),'motan-analysis-bench-')),prefix=join(dir,'log');try{await managerFixture(prefix);const reference=analysisOracle(prefix,analysisNames,.002,3,true),ms=[];for(let run=0;run<9;run++){const start=performance.now(),manager=await MotanLogManager.open(prefix);let result;try{const analyzer=new MotanAnalyzer(manager,.002);for(const name of analysisNames)analyzer.addDataset(name);result=await analyzer.generate(3);}finally{await manager.close();}const elapsed=performance.now()-start;assert.deepEqual(Array.from(result.times),reference.times);for(const [name,values] of Object.entries(result.datasets))assert.deepEqual(Array.from(values),reference.data[name],name);if(run>=2)ms.push(elapsed);}console.log(JSON.stringify({node:process.version,samples:reference.times.length,datasets:Object.keys(reference.data).length,nodeMs:stats(ms),historicalPythonMs:stats(reference.ms),exact:true}));}finally{await rm(dir,{recursive:true,force:true});}
