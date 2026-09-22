import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {motanScalarSmooth,type MotanScalarSeries} from '../src/motan/scalar-math.ts';
import {motanSmooth} from '../src/motan/derived-math.ts';
import {scalarOracle,scalarBits} from './helpers/motan-scalar-oracle.ts';
import {MotanAnalysisExecutor} from '../src/motan/analysis-executor.ts';
import {managerFixture} from './helpers/motan-manager-fixture.ts';
import {scipyReferenceEnvironment,scipyReferencePython} from './helpers/motan-sos-oracle.ts';
test('integer smoothing preserves exact weighting, sequential float sums, half-even windows and truncated edges',()=>{
 const b=1n<<53n,values=[b+1n,-b+3n,b+7n,-b-9n,b+11n];
 let seed=629;const random=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0;
 const mixed=Array.from({length:513},(_,i)=>i%3===0?Boolean(random()%2):i%3===1?(BigInt(random())<<BigInt(random()%869))*BigInt(i%2?-1:1):random()/65536);
 const cases:MotanScalarSeries[]=[values,[true,false,true,true,false],[1n,2n,3n,4n,5n],[-0,0n,false,true,Number.MIN_VALUE],[1n],[],mixed];
 for(const data of cases)for(const smooth of [2,5,6,7,10]){
  assert.deepEqual(scalarBits(motanScalarSmooth(data,1,smooth)),scalarOracle('smooth',data,undefined,1,false,undefined,[String(smooth)]).values);
 }
 assert.notEqual(motanScalarSmooth(values,1,6)[0],motanSmooth(values.map(Number),1,6)[0]);
 assert.deepEqual(Array.from(motanScalarSmooth([1n,2n,3n],1,4)),[5*(1/6),11*(1/6),11*(1/6)]);
 assert.deepEqual(motanScalarSmooth([1n,2n,3n],1,5),motanScalarSmooth([1n,2n,3n],1,4));
 assert.deepEqual(motanScalarSmooth([1n,2n,3n],1,7),motanScalarSmooth([1n,2n,3n],1,8));
});
test('integer smoothing bounds work, result allocation and each conversion or accumulation overflow',()=>{
 for(const data of [[null],['1'],[NaN],[Infinity]] as MotanScalarSeries[])assert.throws(()=>motanScalarSmooth(data,1,4),/numeric scalars/);
 for(const time of [0,1,Infinity,-1,NaN])assert.throws(()=>motanScalarSmooth([1n],1,time),/smoothing/);
 for(const segment of [0,-1,NaN,Infinity])assert.throws(()=>motanScalarSmooth([1n],segment,4),/segment/);
 assert.throws(()=>motanScalarSmooth([1n],1,2000002),/work limit/);
 assert.throws(()=>motanScalarSmooth(Array(26).fill(1n),1,2000000),/work limit/);
 assert.throws(()=>motanScalarSmooth([1n],1,4,7),/memory limit/);
 assert.equal(motanScalarSmooth([1n],1,4,8).length,1);
 assert.throws(()=>motanScalarSmooth([1n],1,4,-1),/budget/);
 assert.throws(()=>motanScalarSmooth([1n<<200000n],1,4),/finite range/);
 assert.throws(()=>motanScalarSmooth([0n,1n<<1023n],1,4),/finite range/);
 assert.throws(()=>motanScalarSmooth([1n<<1023n,1n<<1023n],1,2),/finite range/);
});
test('integer smoothing supports worker chains and no-Python CSV with original exporter results',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-smooth-')),prefix=join(dir,'log'),executor=new MotanAnalysisExecutor();
 try{
  const base=1n<<53n;await managerFixture(prefix,2,'corexy',round=>({a:base+BigInt(round*3+1),yes:round%2===0}));
  const smooth='smooth(status(export_fields.a),.05)',derivative=`derivative(${smooth})`,boolean='smooth(status(export_fields.yes),.07)',columns=[smooth,derivative,boolean];
  const result=await executor.analyze({prefix,datasets:columns,output:'table',preserveNumberTypes:true,duration:5,segmentTime:.01});
  for(const name of columns)assert.ok(result.datasets[name] instanceof Float64Array);
  const root=fileURLToPath(new URL('../../',import.meta.url)),args=[prefix,'-c',JSON.stringify(columns),'--duration','5','--segment-time','.01'];
  const node=execFileSync(process.execPath,[join(root,'scripts/motan/data_export.ts'),...args,'--preserve-number-types'],{encoding:'utf8',env:{...process.env,PATH:'/no-programs'},timeout:10000});
  const python=execFileSync(scipyReferencePython(),[join(root,'scripts/motan/data_export.py'),...args],{encoding:'utf8',env:scipyReferenceEnvironment(),timeout:10000});
  const rows=(csv:string)=>csv.trimEnd().split('\r\n').slice(1).map(row=>row.split(',').map(Number));
  assert.deepEqual(rows(node),rows(python));assert.deepEqual(rows(node),Array.from(result.times,(time,i)=>[time,...columns.map(name=>result.datasets[name][i])]));
 }finally{await executor.close();await rm(dir,{recursive:true,force:true});}
});
