import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {motanScalarSOSFilter,motanSOSFilter,type MotanSOS} from '../src/motan/sos-filter.ts';
import type {MotanScalarSeries} from '../src/motan/scalar-math.ts';
import {scalarBits} from './helpers/motan-scalar-oracle.ts';
import {scalarSOSOracle} from './helpers/motan-scalar-sos-oracle.ts';
import {MotanAnalysisExecutor} from '../src/motan/analysis-executor.ts';
import {managerFixture} from './helpers/motan-manager-fixture.ts';
import {scipyReferenceEnvironment,scipyReferencePython} from './helpers/motan-sos-oracle.ts';
const sos:MotanSOS=[[.5,.5,0,1,0,0],[.25,.5,.25,1,0,0]];
const repeat=(values:MotanScalarSeries)=>Array.from({length:96},(_,i)=>values[i%values.length]);
test('scalar SOS follows NumPy int64/uint64/bool/float inference and integer odd extension before casting',()=>{
 const cases:[string,MotanScalarSeries][]=[['int64',[1n,2n,3n]],['int64',[(1n<<53n)+1n,-(1n<<53n)+3n,7n]],
  ['int64',[(1n<<63n)-1n,-(1n<<63n),(1n<<63n)-2n]],['uint64',[(1n<<63n)+1n,(1n<<64n)-1n,(1n<<63n)+3n]],
  ['float64',[-1n,(1n<<63n)+1n,(1n<<64n)-1n]],['bool',[true,false,true]],['int64',[true,2n,false]],['float64',[(1n<<63n)+1n,1.25,false]]];
 for(const [dtype,values]of cases)for(const mode of ['filt','filtfilt'] as const){
  const source=repeat(values),reference=scalarSOSOracle(source,sos,mode);
  assert.equal(reference.dtype,dtype);assert.equal(reference.error,undefined);
  assert.deepEqual(scalarBits(motanScalarSOSFilter(sos,source,mode,64*1024**2,true)).map(([,bits])=>bits),reference.bits);
 }
 const source=repeat([(1n<<63n)-1n,-(1n<<63n),(1n<<63n)-2n]);
 assert.notDeepEqual(motanScalarSOSFilter(sos,source,'filtfilt'),motanSOSFilter(sos,source.map(Number),'filtfilt'));
});
test('scalar SOS rejects original unsupported object integers, ambiguous inputs, limits and invalid values',()=>{
 for(const values of [[1n<<64n,1.5],[-(1n<<63n)-1n,1n],[1n<<2000n]]){
  const source=repeat(values);for(const mode of ['filt','filtfilt'] as const){
   const expected=scalarSOSOracle(source,sos,mode);assert.equal(expected.dtype,'object');assert.match(expected.error!,/TypeError|OverflowError/);
   assert.throws(()=>motanScalarSOSFilter(sos,source,mode,64*1024**2,true),/object integer/);
  }
 }
 assert.throws(()=>motanScalarSOSFilter(sos,repeat([1n,1.0]),'filtfilt'),/Ambiguous/);
 for(const values of [[null],['1'],[NaN],[Infinity]] as MotanScalarSeries[])assert.throws(()=>motanScalarSOSFilter(sos,repeat(values),'filt'),/finite numeric/);
 assert.throws(()=>motanScalarSOSFilter(sos,[],'filt'),/samples/);
 assert.throws(()=>motanScalarSOSFilter(sos,[1n],'filtfilt'),/padlen/);
 assert.throws(()=>motanScalarSOSFilter(sos,[1n],'filt',7),/memory/);
 assert.throws(()=>motanScalarSOSFilter(sos,[1n],'filt',-1),/budget/);
 assert.equal(motanScalarSOSFilter(sos,[1n],'filt',8).length,1);
});
test('integer SOS worker and no-Python export preserve original filter results and typed input modes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-scalar-sos-')),prefix=join(dir,'log'),executor=new MotanAnalysisExecutor();
 try{
  await managerFixture(prefix,2,'corexy',round=>({signed:round%2===0?-(1n<<63n):(1n<<63n)-1n,unsigned:(1n<<63n)+BigInt(round+2),yes:round%2===0}));
  const columns=['sos(status(export_fields.signed),filtfilt,lowpass,2,10)','sos(status(export_fields.unsigned),filt,notch,10,5)','sos(status(export_fields.yes),filtfilt,highpass,2,10)'];
  const result=await executor.analyze({prefix,datasets:columns,output:'table',preserveNumberTypes:true,duration:5,segmentTime:.01});
  for(const name of columns)assert.ok(result.datasets[name] instanceof Float64Array);
  const root=fileURLToPath(new URL('../../',import.meta.url)),args=[prefix,'-c',JSON.stringify(columns),'--duration','5','--segment-time','.01'];
  const node=execFileSync(process.execPath,[join(root,'scripts/motan/data_export.ts'),...args,'--preserve-number-types'],{encoding:'utf8',env:{...process.env,PATH:'/no-programs'},timeout:10000});
  const python=execFileSync(scipyReferencePython(),[join(root,'scripts/motan/data_export.py'),...args],{encoding:'utf8',env:scipyReferenceEnvironment(),timeout:10000});
  const rows=(csv:string)=>csv.trimEnd().split('\r\n').slice(1).map(row=>row.split(',').map(Number)),actual=rows(node),expected=rows(python);
  assert.deepEqual(actual,Array.from(result.times,(time,i)=>[time,...columns.map(name=>result.datasets[name][i])]));
  assert.equal(actual.length,expected.length);for(let i=0;i<actual.length;i++)for(let j=0;j<actual[i].length;j++)assert.ok(Math.abs(actual[i][j]-expected[i][j])<=1e-10*Math.max(1,Math.abs(expected[i][j]),j===1||j===2?2**63:1),`${i},${j}`);
 }finally{await executor.close();await rm(dir,{recursive:true,force:true});}
});
