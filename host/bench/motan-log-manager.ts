// Original Python results and timing are frozen; this benchmark runs Node only.
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {MotanLogManager} from '../src/motan/log-manager.ts';
import {managerFixture,managerDatasets} from '../test/helpers/motan-manager-fixture.ts';
import {managerOracle} from '../test/helpers/motan-manager-oracle.ts';
const stats=(ms:number[])=>{ms.sort((a,b)=>a-b);return {median:ms[3],p95:ms[6]};},dir=await mkdtemp(join(tmpdir(),'motan-manager-bench-')),prefix=join(dir,'capture');try{await managerFixture(prefix,500);for(const start of [0,960]){const times=Array.from({length:(1000-start)/2},(_,i)=>10+start+2*i+.75),reference=managerOracle(prefix,start,managerDatasets,times,true),ms=[],lag=monitorEventLoopDelay({resolution:1});lag.enable();for(let run=0;run<9;run++){const begin=performance.now(),manager=await MotanLogManager.open(prefix,{start}),values=[];try{for(const name of managerDatasets)manager.addDataset(name);for(const time of times)values.push({...await manager.sample(time)});}finally{await manager.close();}const elapsed=performance.now()-begin;assert.deepEqual(values,reference.values);if(run>=2)ms.push(elapsed);}lag.disable();console.log(JSON.stringify({node:process.version,start,frames:times.length,datasets:managerDatasets.length,nodeMs:stats(ms),historicalPythonMs:stats(reference.ms),maxEventLoopMs:lag.max/1e6,exact:true}));}}finally{await rm(dir,{recursive:true,force:true});}
