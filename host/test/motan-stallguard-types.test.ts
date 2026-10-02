import {legacyMotanCsv} from './helpers/motan-export-reference.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {MotanLogWriter} from '../src/motan/log-writer.ts';
import {MotanLogReader} from '../src/motan/log-reader.ts';
import {MotanStallguardSampler,type MotanStallguardRow} from '../src/motan/diagnostic-samples.ts';
import {MotanAnalysisExecutor} from '../src/motan/analysis-executor.ts';
import {managerFixture} from './helpers/motan-manager-fixture.ts';
const frame='{"q":"stallguard:stepper_x","params":{"data":[[10.1,9007199254740993,1],[10.2,1.0,-0.0],[10.3,true,3],[10.4,0,4]]}}';
test('typed Stallguard keeps integer, float, negative zero and boolean tokens through gzip reader and independent columns',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-stallguard-types-')),path=join(dir,'log.gz');let reader:MotanLogReader|undefined;
 try{
  const writer=await MotanLogWriter.open(path);try{await writer.addData(Buffer.from(frame));}finally{await writer.close();}
  reader=await MotanLogReader.open(path,{preserveNumberTypes:true});const message=await reader.pullMessage(),block=message!.params as {data:MotanStallguardRow[]};
  const sg=new MotanStallguardSampler('sg_result',async()=>block,true),cs=new MotanStallguardSampler('cs_actual',async()=>block,true);
  assert.equal(await sg.sample(10),9007199254740993n);assert.equal(await cs.sample(10),1n);
  assert.equal(await sg.sample(10.15),1);assert.ok(Object.is(await cs.sample(10.15),-0));
  assert.equal(await sg.sample(10.25),true);assert.equal(await cs.sample(10.25),3n);
  // Metadata checks must also detect stale values in a direct caller's row.
  (block.data[2] as unknown as unknown[])[2]=99;await assert.rejects(cs.sample(10.26),/Mutated/);
 }finally{await reader?.close();await rm(dir,{recursive:true,force:true});}
});
test('typed Stallguard remains bounded and fails permanently on invalid rows or excessive metadata',async()=>{
 assert.throws(()=>new MotanStallguardSampler('sg_result',async()=>null,'yes' as unknown as boolean),/type mode/);
 for(const row of [[1,NaN,0],[1,Infinity,0],[1,'1',0],[1n,1,0]]){
  const sampler=new MotanStallguardSampler('sg_result',async()=>({data:[row as unknown as MotanStallguardRow]}),true);
  await assert.rejects(sampler.sample(0),/row/);await assert.rejects(sampler.sample(1),/row/);
 }
 const dir=await mkdtemp(join(tmpdir(),'motan-stallguard-limit-')),path=join(dir,'log.gz');let reader:MotanLogReader|undefined;
 try{
  const writer=await MotanLogWriter.open(path);try{await writer.addData(Buffer.from(JSON.stringify({q:'stallguard:x',params:{data:Array.from({length:22000},()=>[0,1,2])}})));}finally{await writer.close();}
  reader=await MotanLogReader.open(path,{preserveNumberTypes:true});await assert.rejects(reader.pullMessage(),/metadata limit/);await assert.rejects(reader.pullMessage());
 }finally{await reader?.close();await rm(dir,{recursive:true,force:true});}
});
test('typed Stallguard raw CSV and exact status differences match Python through worker and no-Python CLI',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-stallguard-export-')),prefix=join(dir,'log'),executor=new MotanAnalysisExecutor();
 try{
  const wide=9007199254740993n;await managerFixture(prefix,2,'corexy',{wide});
  const name='deviation(status(export_fields.wide),stallguard(stepper_x,sg_result))';
  const result=await executor.analyze({prefix,datasets:[name],output:'table',preserveNumberTypes:true,duration:.02,segmentTime:.01});assert.deepEqual(Array.from(result.datasets[name]),[wide-100n,wide-100n]);
  // Separate raw-token fixture; its first index starts at zero.
  const raw=join(dir,'raw'),writer=await MotanLogWriter.open(raw+'.json.gz'),index=await MotanLogWriter.open(raw+'.index.gz');
  try{await writer.addData(Buffer.from(frame));await index.addData(Buffer.from('{"status":{"toolhead":{"estimated_print_time":10},"configfile":{"settings":{"tmc2209 stepper_x":{}}}},"subscriptions":{"stallguard:stepper_x":{}},"file_position":0}'));}finally{await writer.close();await index.close();}
  const root=fileURLToPath(new URL('../../',import.meta.url)),columns=['stallguard(stepper_x,sg_result)','stallguard(stepper_x,cs_actual)'];
  // Python handlers destructively pop their shared rows when both columns are
  // requested together. Compare each source handler independently; Node's
  // established immutable fanout contract is tested above.
  for(const column of columns){
   const args=[raw,'-c',JSON.stringify([column]),'-d','.3','--segment-time','.05'];
   const node=execFileSync(process.execPath,[join(root,'scripts/motan/data_export.ts'),...args,'--preserve-number-types'],{encoding:'utf8',env:{...process.env,PATH:'/no-programs'}});
   const python=legacyMotanCsv(args);
   const normalize=(text:string)=>text.trimEnd().split('\r\n').slice(1).map(line=>line.split(',').slice(1).map(v=>v==='1.0'?'1':v==='-0.0'?'-0':v));
   assert.deepEqual(normalize(node),normalize(python));if(column===columns[0])assert.ok(node.includes('9007199254740993'));
  }
 }finally{await executor.close();await rm(dir,{recursive:true,force:true});}
});
