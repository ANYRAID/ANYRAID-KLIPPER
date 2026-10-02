import {csvRows,csvBits} from './helpers/motan-csv-reference.ts';
import {legacyMotanCsv} from './helpers/motan-export-reference.ts';
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
   const legacy=legacyMotanCsv(args);
   const snapshotted=legacyMotanCsv(args,true);
   const [actual,expected,original]=[csv,snapshotted,legacy].map(csvRows);
   assert.deepEqual(actual[0],expected[0]);assert.deepEqual(actual[0],original[0]);assert.equal(actual.length,expected.length);assert.equal(actual.length,original.length);assert.notEqual(actual[1][2],original[1][2],'fixture must expose legacy whole-object aliasing');
   for(let i=1;i<actual.length;i++){assert.equal(actual[i][1],original[i][1]);assert.equal(actual[i][3],original[i][3]);assert.equal(csvBits(actual[i][0]),csvBits(expected[i][0]));assert.deepEqual(actual[i].slice(1),expected[i].slice(1));}
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});
