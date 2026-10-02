import {legacyMotanCsv} from './helpers/motan-export-reference.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseTypedMotanJson,motanTypedValue,cloneMotanJson,mergeMotanObjects,copyMotanStatusRoot} from '../src/motan/number-types.ts';
import {parseMotanJson} from '../src/motan/capture.ts';
import {MotanLogWriter} from '../src/motan/log-writer.ts';
import {MotanLogReader} from '../src/motan/log-reader.ts';
import {MotanLogManager} from '../src/motan/log-manager.ts';
import {MotanAnalysisExecutor} from '../src/motan/analysis-executor.ts';
const object=(source:string)=>parseTypedMotanJson(source) as Record<string,unknown>;

test('Motan token provenance distinguishes integer/decimal/exponent/negative zero and survives explicit clones',()=>{
 const value=object('{"i":1,"f":1.0,"e":1e0,"z":-0,"nz":-0.0,"wide":9007199254740993,"nested":{"i":2},"array":[3,3.0],"__proto__":{"i":4}}');
 for(const copy of [value,cloneMotanJson(value)]){
  assert.equal(copy.i,1);assert.equal(motanTypedValue(copy,'i'),1n);assert.equal(motanTypedValue(copy,'f'),1);
  assert.equal(motanTypedValue(copy,'e'),1);assert.equal(motanTypedValue(copy,'z'),0n);assert.ok(Object.is(motanTypedValue(copy,'nz'),-0));
  assert.equal(motanTypedValue(copy,'wide'),9007199254740993n);
  assert.equal(motanTypedValue(copy.nested as Record<string,unknown>,'i'),2n);
  assert.equal(motanTypedValue(copy.array as Record<string,unknown>,'0'),3n);assert.equal(motanTypedValue(copy.array as Record<string,unknown>,'1'),3);
  assert.equal(motanTypedValue(copy.__proto__ as Record<string,unknown>,'i'),4n);
  assert.deepEqual(Object.keys(copy),Object.keys(value));
 }
 assert.equal(({} as Record<string,unknown>).i,undefined);
 const huge=1n<<2000n;assert.equal(object('{"v":'+huge+'}').v,huge);
 assert.throws(()=>object('{"v":1e400}'),/Non-finite/);
 assert.throws(()=>object('{"v":['+Array(65537).fill('1').join(',')+']}'),/metadata limit/);
 assert.throws(()=>object('{"v":'+ '1'.repeat(4301)+'}'),/digit limit/);
 value.i=2;assert.throws(()=>motanTypedValue(value,'i'),/Mutated/);
 const normal=parseMotanJson(Buffer.from('{"i":1}')) as Record<string,unknown>;assert.equal(motanTypedValue(normal,'i'),1);
});
test('Motan copy-on-write merges clear overwritten integer tags and retain independent nested snapshots',()=>{
 const initial=object('{"i":1,"keep":2,"child":{"v":3},"__proto__":4}');
 const next=mergeMotanObjects(initial,object('{"i":1.0,"child":{"v":5.0},"__proto__":null}'));
 const last=mergeMotanObjects(next,object('{"i":1}'));
 assert.equal(motanTypedValue(initial,'i'),1n);assert.equal(motanTypedValue(next,'i'),1);assert.equal(motanTypedValue(last,'i'),1n);
 assert.equal(motanTypedValue(last,'keep'),2n);assert.equal(motanTypedValue(last,'__proto__'),null);
 assert.equal(motanTypedValue(next.child as Record<string,unknown>,'v'),5);
 assert.equal(motanTypedValue(initial.child as Record<string,unknown>,'v'),3n);
 assert.equal(motanTypedValue(mergeMotanObjects(initial,{i:1}),'i'),1);
 const floats=object('{"sensor":{"i":1.0}}'),update=object('{"sensor":{"i":1}}'),root=copyMotanStatusRoot(floats,update);
 root.sensor=mergeMotanObjects(floats.sensor as Record<string,unknown>,update.sensor as Record<string,unknown>);
 assert.equal(motanTypedValue(cloneMotanJson(root).sensor as Record<string,unknown>,'i'),1n);
});
async function fixture(prefix:string){
 const log=await MotanLogWriter.open(prefix+'.json.gz'),index=await MotanLogWriter.open(prefix+'.index.gz');
 const initial='{"toolhead":{"estimated_print_time":10.0},"sensor":{"i":1,"f":1.0,"wide":9007199254740993,"small":1},"configfile":{"settings":{"printer":{"kinematics":"cartesian"}}}}';
 try{
  await index.addData(Buffer.from('{"status":'+initial+',"subscriptions":{},"file_position":0}'));
  await log.addData(Buffer.from('{"q":"status","params":{"status":'+initial+'}}'));
  for(const [time,token]of [[11,'1.0'],[12,'1'],[13,'2.0']] as const){
   const status=`{"toolhead":{"estimated_print_time":${time}.0},"sensor":{"i":${token}}}`;
   await log.addData(Buffer.from('{"q":"status","params":{"status":'+status+'}}'));
   const position=await log.flush();await index.addData(Buffer.from('{"status":'+status+',"file_position":'+position+'}'));
  }
 }finally{await log.close();await index.close();}
}
test('typed status sampling carries provenance through gzip, initial/index clones, COW updates and seek',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-types-')),prefix=join(dir,'log');
 try{
  await fixture(prefix);
  for(const preserveNumberTypes of [false,true]){
   const manager=await MotanLogManager.open(prefix,{reader:{preserveNumberTypes}});
   try{
    manager.addDataset('status(sensor.i)');manager.addDataset('status(sensor.f)');
    const values=[];for(const time of [10.1,11.1,12.1,13.1])values.push((await manager.sample(time))['status(sensor.i)']);
    assert.deepEqual(values,preserveNumberTypes?[1n,1,1n,2]:[1,1,1,2]);
    assert.equal((await manager.sample(13.2))['status(sensor.f)'],1);
   }finally{await manager.close();}
  }
  const mutable={preserveNumberTypes:true},opening=MotanLogReader.open(prefix+'.index.gz',mutable);mutable.preserveNumberTypes=false;
  const reader=await opening;try{const record=await reader.pullMessage();assert.equal(motanTypedValue((record!.status as Record<string,unknown>).sensor as Record<string,unknown>,'i'),1n);}finally{await reader.close();}
  const options={reader:{preserveNumberTypes:true}},pending=MotanLogManager.open(prefix,options);options.reader.preserveNumberTypes=false;
  const snapped=await pending;try{snapped.addDataset('status(sensor.i)');assert.equal((await snapped.sample(10.1))['status(sensor.i)'],1n);}finally{await snapped.close();}
  const seek=await MotanLogManager.open(prefix,{start:2.1,reader:{preserveNumberTypes:true}});
  try{assert.ok(seek.filePosition>0);assert.equal(motanTypedValue(seek.initialStatus.sensor as Record<string,unknown>,'i'),1n);assert.equal(motanTypedValue(seek.startStatus.sensor as Record<string,unknown>,'i'),1);seek.addDataset('status(sensor.i)');assert.equal((await seek.sample(12.1))['status(sensor.i)'],1n);}finally{await seek.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('opt-in worker and CSV subtract wide and small integer tokens exactly without Python',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-types-cli-')),prefix=join(dir,'log'),executor=new MotanAnalysisExecutor();
 try{
  await fixture(prefix);const name='deviation(status(sensor.wide),status(sensor.small))';
  const request={prefix,datasets:[name],output:'table' as const,preserveNumberTypes:true,duration:.02,segmentTime:.01};
  const result=await executor.analyze(request);assert.deepEqual([...new Set(result.datasets[name])],[9007199254740992n]);
  await assert.rejects(executor.analyze({...request,preserveNumberTypes:false}),/Ambiguous/);
  await assert.rejects(executor.analyze({...request,output:'numeric'}),/request/);
  const cli=fileURLToPath(new URL('../../scripts/motan/data_export.ts',import.meta.url));
  const csv=execFileSync(process.execPath,[cli,prefix,'-c',JSON.stringify([name]),'--preserve-number-types','-d','.02','--segment-time','.01'],{encoding:'utf8',env:{...process.env,PATH:'/no-programs'},timeout:10000});
  assert.ok(csv.split('\r\n').slice(1,-1).every(row=>row.endsWith(',9007199254740992')));
  const legacy=legacyMotanCsv([prefix,'-c',JSON.stringify([name]),'-d','.02','--segment-time','.01']);
  const decode=(text:string)=>text.trimEnd().split('\r\n').slice(1).map(row=>{const [time,value]=row.split(',');return [Number(time),value];});
  assert.equal(csv.split('\r\n')[0],legacy.split('\r\n')[0]);assert.deepEqual(decode(csv),decode(legacy));
 }finally{await executor.close();await rm(dir,{recursive:true,force:true});}
});
