import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {MotanLogManager} from '../src/motan/log-manager.ts';
import {MotanAnalyzer} from '../src/motan/analyzer.ts';
import {managerFixture} from '../test/helpers/motan-manager-fixture.ts';
const stats=(ms:number[])=>{ms.sort((a,b)=>a-b);return {median:ms[Math.floor(ms.length/2)],p95:ms[Math.ceil(ms.length*.95)-1]};};
const dir=await mkdtemp(join(tmpdir(),'motan-scalar-batch-bench-')),root=fileURLToPath(new URL('../../',import.meta.url)),prefix=join(dir,'log'),oldRef='dca8a8e9';
try{
 const paths=Object.fromEntries(['manager','analyzer','worker','executor','cli'].map(name=>[name,join(dir,`${name}.mts`)])),url=(name:string)=>pathToFileURL(paths[name]).href;
 const baseline=async(path:string,name:string,replacements:Record<string,string>={})=>{
  const origin=pathToFileURL(join(root,path));let source=execFileSync('git',['show',`${oldRef}:${path}`],{encoding:'utf8'});
  source=source.replace(/(from |import\()'([^']+)'/g,(whole,lead:string,spec:string)=>spec.startsWith('.')?`${lead}'${replacements[spec]??new URL(spec,origin).href}'`:whole);
  if(name==='executor')source=source.replace("new URL('./analysis-worker.ts',import.meta.url)",`new URL('${url('worker')}')`);
  await writeFile(paths[name],source);
 };
 await baseline('host/src/motan/log-manager.ts','manager');
 await baseline('host/src/motan/analyzer.ts','analyzer',{'./log-manager.ts':url('manager')});
 await baseline('host/src/motan/analysis-worker.ts','worker',{'./log-manager.ts':url('manager'),'./analyzer.ts':url('analyzer')});
 await baseline('host/src/motan/analysis-executor.ts','executor');
 await baseline('scripts/motan/data_export.ts','cli',{'../../host/src/motan/analysis-executor.ts':url('executor')});
 const oldManager=(await import(url('manager'))).MotanLogManager,oldAnalyzer=(await import(url('analyzer'))).MotanAnalyzer;
 await managerFixture(prefix,10,'corexy',{wide:9007199254740993n,text:'bench',nil:null,yes:true});
 const mixed=['trapq(toolhead,x)','derivative(trapq(toolhead,x))','step_phase(tmc2209 stepper_x)','stallguard(stepper_x,sg_result)','status(export_fields.wide)','status(export_fields.text)','status(export_fields.nil)','status(export_fields.yes)'];
 for(const columns of [['step_phase(tmc2209 stepper_x)'],mixed])for(const typed of [false,true]){
  const ms:{old:number[];current:number[]}={old:[],current:[]};let expected:unknown;
  for(let run=0;run<35;run++)for(const mode of run%2?['current','old'] as const:['old','current'] as const){
   const manager=await (mode==='old'?oldManager:MotanLogManager).open(prefix,{reader:{preserveNumberTypes:typed}});
   try{
    const analyzer=mode==='old'?new oldAnalyzer(manager,.001):new MotanAnalyzer(manager,.001);for(const name of columns)analyzer.addDataset(name);
    const start=performance.now(),result=await analyzer.generateTable(20),elapsed=performance.now()-start;if(expected===undefined)expected=result;else assert.deepEqual(result,expected);if(run>=20)ms[mode].push(elapsed);
   }finally{await manager.close();}
  }
  console.log(JSON.stringify({scope:'20000 samples; gzip/log consumption, scalar accounting and analysis; excludes manager open, dataset setup and CSV. 20 warmups/15 runs, alternating.',node:process.version,oldRef,columns:columns.length,typed,oldMs:stats(ms.old),nodeMs:stats(ms.current),exactTypesAndValues:true}));
  const outputs:Record<string,string>={};
  for(const mode of ['old','current','python']){
   const args=[mode==='old'?paths.cli:join(root,`scripts/motan/data_export.${mode==='python'?'py':'ts'}`),prefix,'-c',JSON.stringify(columns),'-d','20','--segment-time','.001',...(typed&&mode!=='python'?['--preserve-number-types']:[])],times:number[]=[];let output='';
   for(let run=0;run<9;run++){const start=performance.now();output=execFileSync(mode==='python'?'python3':process.execPath,args,{encoding:'utf8',maxBuffer:32*1024**2,timeout:30000});if(run>=2)times.push(performance.now()-start);}
   outputs[mode]=output;console.log(JSON.stringify({scope:'20000 rows including startup, worker, gzip, analysis, CSV, stdout; 2 warmups/7 runs',node:process.version,oldRef,columns:columns.length,typed,mode,ms:stats(times)}));
  }
  assert.equal(outputs.current,outputs.old);
  const rows=(text:string)=>text.trimEnd().split('\r\n').slice(1).map(line=>line.split(',').map((v,i)=>i<=(columns.length===1?1:4)&&v!==''?Number(v):v));
  assert.deepEqual(rows(outputs.current),rows(outputs.python));console.log(JSON.stringify({columns:columns.length,typed,byteExactWithOld:true,pythonValuesExact:true}));
 }
}finally{await rm(dir,{recursive:true,force:true});}
