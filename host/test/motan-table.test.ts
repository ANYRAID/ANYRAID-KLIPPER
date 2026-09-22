import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {MotanAnalysisExecutor} from '../src/motan/analysis-executor.ts';
import {MotanAnalyzer} from '../src/motan/analyzer.ts';
import {MotanLogManager} from '../src/motan/log-manager.ts';
import {managerFixture} from './helpers/motan-manager-fixture.ts';
import {scipyReferenceEnvironment,scipyReferencePython} from './helpers/motan-sos-oracle.ts';
const fields={text:'逗号, "引号"\r\n换行',wide:9007199254740993123456789n,empty:null,yes:true,no:false};
const names=[...Object.keys(fields).map(key=>`status(export_fields.${key})`),'status(export_fields.absent)','stallguard(stepper_x,sg_result)','derivative(trapq(toolhead,x))'];
test('Motan table worker preserves mixed scalars, EOF gaps and exact numeric dependencies',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-table-')),prefix=join(dir,'log'),executor=new MotanAnalysisExecutor();
 try{
  await managerFixture(prefix,2,'corexy',fields);
  const manager=await MotanLogManager.open(prefix);let expected;
  try{const analyzer=new MotanAnalyzer(manager,.01);for(const name of names)analyzer.addDataset(name);expected=await analyzer.generateTable(5);}finally{await manager.close();}
  const table=await executor.analyze({prefix,datasets:names,output:'table',segmentTime:.01,duration:5});
  assert.deepEqual(table,expected);assert.ok(Object.isFrozen(table.datasets[names[0]]));
  for(const [key,value]of Object.entries(fields))assert.equal(table.datasets[`status(export_fields.${key})`][0],value);
  assert.equal(table.datasets['status(export_fields.absent)'][0],0);
  assert.ok(Array.from(table.datasets['stallguard(stepper_x,sg_result)']).includes(null));
  const numeric=await executor.analyze({prefix,datasets:['derivative(trapq(toolhead,x))'],segmentTime:.01,duration:5});
  assert.deepEqual(table.datasets['derivative(trapq(toolhead,x))'],numeric.datasets['derivative(trapq(toolhead,x))']);
 }finally{await executor.close();await rm(dir,{recursive:true,force:true});}
});
test('Motan table bounds scalar payload and rejects lossy derived BigInt conversion',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-table-limit-')),prefix=join(dir,'log'),executor=new MotanAnalysisExecutor();
 try{
  await managerFixture(prefix,2,'corexy',{...fields,text:'x'.repeat(1000)});
  await assert.rejects(executor.analyze({prefix,datasets:['status(export_fields.text)'],output:'table',segmentTime:.01,duration:.2,maxNumericBytes:4096}),/table memory/);
  await assert.rejects(executor.analyze({prefix,datasets:['deviation(status(export_fields.wide),trapq(toolhead,x))'],output:'table',segmentTime:.01,duration:.2}),/Ambiguous mixed/);
  await assert.rejects(executor.analyze({prefix,datasets:['status(export_fields)'],output:'table',segmentTime:.01,duration:.2}),/finite scalar/);
  await assert.rejects(executor.analyze({prefix,datasets:['status(export_fields.wide)'],segmentTime:.01,duration:.2}),/cannot represent/);
  assert.equal((await executor.analyze({prefix,datasets:['status(export_fields.wide)'],output:'table',segmentTime:.01,duration:.02})).datasets['status(export_fields.wide)'][0],fields.wide);
 }finally{await executor.close();await rm(dir,{recursive:true,force:true});}
});
test('Motan mixed CSV CLI matches Python text, BigInt, boolean and empty fields without Python runtime',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-table-cli-')),prefix=join(dir,'log'),root=fileURLToPath(new URL('../../',import.meta.url));
 try{
  await managerFixture(prefix,2,'corexy',fields);
  const columns=[...names,names[0]],args=[prefix,'-c',JSON.stringify(columns),'-d','5','--segment-time','.01'];
  const csv=execFileSync(process.execPath,[join(root,'scripts/motan/data_export.ts'),...args],{encoding:'utf8',env:{...process.env,PATH:'/no-programs'},timeout:15000});
  const legacy=execFileSync(scipyReferencePython(),[join(root,'scripts/motan/data_export.py'),...args],{encoding:'utf8',env:scipyReferenceEnvironment(),timeout:15000});
  const result=execFileSync(scipyReferencePython(),['-c',`import csv,io,json,sys,struct
x=json.load(sys.stdin)
a,b=[list(csv.reader(io.StringIO(s,newline=''))) for s in x]
assert a[0]==b[0]
assert len(a)==len(b)
for left,right in zip(a[1:],b[1:]):
 for i,(p,n) in enumerate(zip(left,right)):
  if i in (0,6,7,8) and p and n: assert struct.pack('>d',float(p))==struct.pack('>d',float(n))
  else: assert p==n, (i,p,n)
print('exact')`],{encoding:'utf8',input:JSON.stringify([legacy,csv])});
  assert.equal(result.trim(),'exact');assert.ok(csv.includes(fields.wide.toString()));
 }finally{await rm(dir,{recursive:true,force:true});}
});
