import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import * as current from '../src/motan/capture.ts';
const root=fileURLToPath(new URL('../../',import.meta.url)),dir=await mkdtemp(join(tmpdir(),'motan-order-bench-')),oldRef='7ad8d8cb';
const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {median:values[Math.floor(values.length/2)],p95:values[Math.ceil(values.length*.95)-1]};};
try{
 for(const name of ['number-types','capture']){
  const path=`host/src/motan/${name}.ts`,origin=pathToFileURL(join(root,path));
  let source=execFileSync('git',['show',`${oldRef}:${path}`],{encoding:'utf8'});
  source=source.replace(/from '([^']+)'/g,(all,spec:string)=>spec.startsWith('.')?`from '${spec==='./number-types.ts'?pathToFileURL(join(dir,'number-types.mts')).href:new URL(spec,origin).href}'`:all);
  await writeFile(join(dir,`${name}.mts`),source);
 }
 const old=await import(pathToFileURL(join(dir,'capture.mts')).href) as typeof current;
 for(const ordered of [false,true]){
  const sensor=ordered?'"name":"sensor","2":1,"1":1.0,"nested":{"4":"four","3":"three"}':'"name":"sensor","position":1,"velocity":1.0,"nested":{"first":"four","second":"three"}';
  const raw=Buffer.from('{"q":"status","params":{"eventtime":1.0,"status":{"sensor":{'+sensor+'}}}}');
  const expected=current.encodeMotanJson(current.parseMotanJson(raw,true));assert.deepEqual(JSON.parse(expected.toString()),JSON.parse(raw.toString()));
  const python=JSON.parse(execFileSync('python3',['-c',`import json,sys,time
raw=sys.stdin.read();times=[]
for run in range(35):
 start=time.perf_counter()
 for i in range(1000): encoded=json.dumps(json.loads(raw),separators=(',',':'))
 elapsed=(time.perf_counter()-start)*1000
 if run>=20: times.append(elapsed)
print(json.dumps({'times':times,'encoded':encoded,'version':sys.version.split()[0]}))`],{input:raw,encoding:'utf8',timeout:30000}));
  assert.equal(expected.toString(),python.encoded);
  console.log(JSON.stringify({python:python.version,ordered,scope:'1000 Python json loads/dumps; excludes process startup, 20 warmups/15 runs',pythonMs:stats(python.times),exactOrderedOutput:true}));
  const records=Array.from({length:1000},(_,i)=>Buffer.from(raw.toString().replace('"eventtime":1.0',`"eventtime":${i}.0`)));
  for(const capture of [false,true]){
   const times={old:[] as number[],current:[] as number[]};
   for(let run=0;run<35;run++)for(const mode of run%2?['current','old'] as const:['old','current'] as const){
    const api=mode==='old'?old:current;let bytes=0;
    const owner=capture?new api.MotanCapture({log:{async addRecords(){},async flush(){return 0;}},index:{async addRecords(chunks){bytes+=chunks.reduce((sum,x)=>sum+x.length,0);}}},async()=>{},[],()=>{}):undefined;
    if(owner)await owner.start();const start=performance.now();
    if(owner)await owner.accept(records);else for(let i=0;i<1000;i++)bytes+=api.encodeMotanJson(api.parseMotanJson(raw,true)).length;
    const elapsed=performance.now()-start;if(run>=20)times[mode].push(elapsed);assert.ok(bytes>0);
   }
   console.log(JSON.stringify({node:process.version,oldRef,ordered,scope:capture?'1000 status updates with capture merging/index encoding; memory sink, no compression or IO':'1000 typed parses and JSON encodes',warmups:20,runs:15,oldMs:stats(times.old),currentMs:stats(times.current),baselinePreservesNumericKeyOrder:!ordered}));
  }
 }
}finally{await rm(dir,{recursive:true,force:true});}
