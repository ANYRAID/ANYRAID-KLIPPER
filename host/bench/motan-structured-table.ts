import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {MotanLogManager} from '../src/motan/log-manager.ts';
import {MotanAnalyzer} from '../src/motan/analyzer.ts';
import {parseTypedMotanJson} from '../src/motan/number-types.ts';
import {managerFixture} from '../test/helpers/motan-manager-fixture.ts';
const root=fileURLToPath(new URL('../../',import.meta.url)),dir=await mkdtemp(join(tmpdir(),'motan-structured-bench-')),oldRef='92b0aa6f';
const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {median:values[Math.floor(values.length/2)],p95:values[Math.ceil(values.length*.95)-1]};};
try{
 for(const name of ['log-manager','analyzer']){
  const path=`host/src/motan/${name}.ts`,origin=pathToFileURL(join(root,path));let source=execFileSync('git',['show',`${oldRef}:${path}`],{encoding:'utf8'});
  source=source.replace(/from '([^']+)'/g,(all,spec:string)=>spec.startsWith('.')?`from '${spec==='./log-manager.ts'?pathToFileURL(join(dir,'log-manager.mts')).href:new URL(spec,origin).href}'`:all);await writeFile(join(dir,`${name}.mts`),source);
 }
 const OldManager=(await import(pathToFileURL(join(dir,'log-manager.mts')).href)).MotanLogManager,OldAnalyzer=(await import(pathToFileURL(join(dir,'analyzer.mts')).href)).MotanAnalyzer;
 for(const shape of ['primitive','structured-fixed','structured-updates']){
  const prefix=join(dir,shape),name='status(export_fields.value)';
  const fields=(round:number)=>parseTypedMotanJson('{"value":'+(shape==='primitive'?'123.0':'{"2":['+Array.from({length:32},(_,i)=>String(i)+(i%2?'.0':'')).join(',')+'],"1":"雪😀, quote\\\"","round":'+round+'}')+'}') as Record<string,unknown>;
  await managerFixture(prefix,10,'corexy',shape==='structured-updates'?fields:fields(0));
  const modes=shape==='primitive'?['old','current']:['current'],times:Record<string,number[]>={old:[],current:[]};let expected:unknown;
  for(let run=0;run<35;run++)for(const mode of run%2?[...modes].reverse():modes){
   const manager=await(mode==='old'?OldManager:MotanLogManager).open(prefix,{reader:{preserveNumberTypes:true}});
   try{const analyzer=mode==='old'?new OldAnalyzer(manager,.001):new MotanAnalyzer(manager,.001);analyzer.addDataset(name);const start=performance.now(),result=await analyzer.generateTable(20),elapsed=performance.now()-start;
    if(expected===undefined)expected=result;else assert.deepEqual(result,expected);if(run>=20)times[mode].push(elapsed);
   }finally{await manager.close();}
  }
  console.log(JSON.stringify({node:process.version,oldRef,shape,scope:'20000 typed rows; gzip/sampling/table accounting, excludes manager open/CSV; 20 warmups/15 runs',currentMs:stats(times.current),...shape==='primitive'?{oldMs:stats(times.old)}:{}}));
  const outputs:Record<string,string>={};
  for(const mode of ['current','python']){
   const args=[join(root,`scripts/motan/data_export.${mode==='python'?'py':'ts'}`),prefix,'-c',JSON.stringify([name]),'-d','20','--segment-time','.001',...mode==='current'?['--preserve-number-types']:[]],samples:number[]=[];
   for(let run=0;run<9;run++){const start=performance.now();outputs[mode]=execFileSync(mode==='python'?'python3':process.execPath,args,{encoding:'utf8',timeout:30000,maxBuffer:32*1024**2});if(run>=2)samples.push(performance.now()-start);}
   console.log(JSON.stringify({shape,mode,scope:'20000 CSV rows including startup/worker/gzip/sampling/CSV/stdout; 2 warmups/7 runs',ms:stats(samples)}));
  }
  const exact=execFileSync('python3',['-c',`import csv,io,json,sys,struct
x=json.load(sys.stdin);a,b=[list(csv.reader(io.StringIO(s,newline=''))) for s in x['outputs']]
assert a[0]==b[0] and len(a)==len(b)
for left,right in zip(a[1:],b[1:]):
 assert struct.pack('>d',float(left[0]))==struct.pack('>d',float(right[0]))
 if x['primitive']: assert float(left[1])==float(right[1])
 else: assert left[1:]==right[1:]
print('exact')`],{input:JSON.stringify({outputs:[outputs.current,outputs.python],primitive:shape==='primitive'}),encoding:'utf8',maxBuffer:32*1024**2});assert.equal(exact.trim(),'exact');
  console.log(JSON.stringify({shape,pythonValuesExact:true}));
 }
}finally{await rm(dir,{recursive:true,force:true});}
