import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {managerFixture} from './helpers/motan-manager-fixture.ts';
import {parseTypedMotanJson} from '../src/motan/number-types.ts';
import {motanPythonRepr} from '../src/motan/python-repr.ts';
import {motanScalarBytes,motanStructuredCell} from '../src/motan/table.ts';
import {MotanLogManager} from '../src/motan/log-manager.ts';
import {MotanAnalysisExecutor} from '../src/motan/analysis-executor.ts';
import {motanCsvChunks,writeMotanCsv} from '../src/motan/csv-export.ts';
const root=fileURLToPath(new URL('../../',import.meta.url));
const source='{"value":{"2":[1,1.0,-0.0,true,null,9007199254740993,"雪😀\\n"],"1":{"quote":"a\'b\\\"c","float":1e-5}},"other":1.0}';
const fields=()=>parseTypedMotanJson(source) as Record<string,unknown>;
const name='status(export_fields.value)';

test('structured table cells cross worker unchanged, cache frozen snapshots and reject arithmetic without coercion',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-structured-')),prefix=join(dir,'log'),executor=new MotanAnalysisExecutor();
 try{
  await managerFixture(prefix,2,'corexy',fields());
  const request={prefix,datasets:[name],output:'table' as const,preserveNumberTypes:true,segmentTime:.01,duration:.1};
  const result=await executor.analyze(request),values=result.datasets[name];
  const expected=motanStructuredCell(motanPythonRepr(fields().value));
  assert.deepEqual(values[0],expected);assert.ok(Object.isFrozen(values[0]));assert.equal(values[0],values[1]);
  for(const value of values)assert.deepEqual(value,expected);
  await assert.rejects(executor.analyze({...request,preserveNumberTypes:false}),/finite scalar/);
  for(const dataset of [`derivative(${name})`,`norm2(${name},${name})`,`deviation(${name},${name})`,`smooth(${name})`,`integral(${name})`])await assert.rejects(executor.analyze({...request,datasets:[dataset]}),/numeric scalars/);
  const filename=join(dir,'out.csv');await writeFile(filename,'previous');
  await assert.rejects(writeMotanCsv(result,[name],filename,{maxOutputBytes:40}),/output limit/);assert.equal(await readFile(filename,'utf8'),'previous');
  const chunks:Buffer[]=[];for await(const chunk of motanCsvChunks(result,[name,name]))chunks.push(chunk);assert.ok(Buffer.concat(chunks).toString().includes('9007199254740993'));
  const cancelled=new AbortController();cancelled.abort();await assert.rejects(writeMotanCsv(result,[name],filename,{signal:cancelled.signal}),/abort/i);assert.equal(await readFile(filename,'utf8'),'previous');
 }finally{await executor.close();await rm(dir,{recursive:true,force:true});}
});

test('structured batch charges each cell payload even when cached and permanently latches budget failures',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-structured-budget-')),prefix=join(dir,'log');
 try{
  await managerFixture(prefix,2,'corexy',fields());const cell=motanStructuredCell(motanPythonRepr(fields().value)),charge=motanScalarBytes(cell),budget=2*(charge+8);
  for(const limit of [budget,budget-1]){
   const manager=await MotanLogManager.open(prefix,{reader:{preserveNumberTypes:true}});manager.addDataset(name);
   try{if(limit===budget){const result=await manager.sampleScalars([11,11],limit);assert.equal(result.scalarBytes,2*charge);assert.deepEqual(result.datasets[name],[cell,cell]);assert.equal(result.datasets[name][0],result.datasets[name][1]);}
    else{await assert.rejects(manager.sampleScalars([11,11],limit),/memory/);assert.equal(manager.status.failed,true);await assert.rejects(manager.sampleScalars([11]),/memory/);}
   }finally{await manager.close();}
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('structured CSV matches original fields and fixes mutable whole-object history through transitions and seek',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-structured-cli-')),prefix=join(dir,'log');
 try{
  const variants=[source,'{"value":[{"3":3.0,"2":2},[],false],"other":2.0}',JSON.stringify({value:'plain, "text"',other:3}),' {"value":null,"other":4.0}'];
  await managerFixture(prefix,3,'corexy',round=>parseTypedMotanJson(variants[round+1]) as Record<string,unknown>);
  const columns=[name,'status(export_fields)',name];
  for(const skip of ['0','2.1']){
   const args=[prefix,'-c',JSON.stringify(columns),'-d','7','-s',skip,'--segment-time','.1'];
   const csv=execFileSync(process.execPath,[join(root,'scripts/motan/data_export.ts'),...args,'--preserve-number-types'],{encoding:'utf8',env:{...process.env,PATH:'/no-programs'},timeout:15000});
   const legacy=execFileSync('python3',[join(root,'scripts/motan/data_export.py'),...args],{encoding:'utf8',timeout:15000});
   const snapshotted=execFileSync('python3',['-c',`import sys,runpy,copy,os
sys.path.insert(0,os.path.dirname(sys.argv[1]));import readlog
original=readlog.HandleStatusField.pull_data
def snapshot(self,time): return copy.deepcopy(original(self,time))
readlog.HandleStatusField.pull_data=snapshot
sys.argv=sys.argv[1:];runpy.run_path(sys.argv[0],run_name='__main__')`,join(root,'scripts/motan/data_export.py'),...args],{encoding:'utf8',timeout:15000});
   const exact=execFileSync('python3',['-c',`import csv,io,json,sys,struct
x=json.load(sys.stdin);a,b,original=[list(csv.reader(io.StringIO(s,newline=''))) for s in x]
assert a[0]==b[0]==original[0] and len(a)==len(b)==len(original)
assert a[1][2]!=original[1][2], 'fixture must expose legacy whole-object aliasing'
for left,old in zip(a[1:],original[1:]):
 assert left[1]==old[1] and left[3]==old[3]
for left,right in zip(a[1:],b[1:]):
 assert struct.pack('>d',float(left[0]))==struct.pack('>d',float(right[0]))
 assert left[1:]==right[1:], (left,right)
print('exact')`],{input:JSON.stringify([csv,snapshotted,legacy]),encoding:'utf8'});assert.equal(exact.trim(),'exact');
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});
