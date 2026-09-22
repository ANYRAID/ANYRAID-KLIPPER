import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {motanScalarNorm2,type MotanScalarSeries} from '../src/motan/scalar-math.ts';
import {scalarOracle,scalarBits} from './helpers/motan-scalar-oracle.ts';
import {MotanAnalysisExecutor} from '../src/motan/analysis-executor.ts';
import {managerFixture} from './helpers/motan-manager-fixture.ts';
import {scipyReferenceEnvironment} from './helpers/motan-sos-oracle.ts';
test('scalar norm squares integers before ordered float accumulation and matches Python bits',()=>{
 const base=(1n<<53n)+1n;
 const cases:MotanScalarSeries[][]=[[[base-1n],[base-1n],[base]],[[base+1n],[base]],[[base,-base,0n,1n],[0n,1n,0n,2n]],[[true,false,true,false],[false,true,true,false]],[[base,1n,true,-0],[.5,false,2n,0n],[3n,2.5,0n,0]],[[1.25,-0,Number.MIN_VALUE],[2.5,0,0]]];
 let state=715;const random=()=>state=(Math.imul(state,1664525)+1013904223)>>>0;
 const make=()=>Array.from({length:2048},(_,i)=>i%3===0?Boolean(random()%2):i%3===1?(BigInt(random())<<BigInt(random()%469))+BigInt(random()):random()/65536);
 cases.push([make(),make(),make()]);
 for(const series of cases){const actual=motanScalarNorm2(series),expected=scalarOracle('norm2',series[0],series[1],.01,false,series[2]);assert.deepEqual(scalarBits(actual),expected.values);}
 assert.notEqual(motanScalarNorm2([[base+1n],[base]])[0],Math.sqrt(Number(base+1n)**2+Number(base)**2));
 assert.notEqual(motanScalarNorm2([[base-1n],[base-1n],[base]])[0],Math.sqrt(Number(2n*(base-1n)**2n+base**2n)));
 assert.ok(Object.is(motanScalarNorm2([[-0],[false]])[0],0));
 assert.deepEqual(Array.from(motanScalarNorm2([[3n],[4n,12n]])),[5]);
 assert.equal(motanScalarNorm2([[],[]]).length,0);
});
test('scalar norm rejects invalid shapes, individual and accumulated overflow and output over budget',()=>{
 for(const series of [[[null],[1n]],[['2'],[1n]],[[Infinity],[0]],[[NaN],[0]]] as MotanScalarSeries[][])assert.throws(()=>motanScalarNorm2(series),/numeric scalars/);
 assert.throws(()=>motanScalarNorm2([[1n]]),/two or three/);
 assert.throws(()=>motanScalarNorm2([[1n,2n],[1n]]),/shorter/);
 assert.throws(()=>motanScalarNorm2([[1n<<200000n],[0n]]),/finite range/);
 assert.throws(()=>motanScalarNorm2([[-(1n<<512n)],[0n]]),/finite range/);
 assert.throws(()=>motanScalarNorm2([[1n<<511n],[1n<<511n],[1n<<511n]],7),/memory limit/);
 assert.throws(()=>motanScalarNorm2([[(1n<<512n)-1n],[0n]]),/finite range/);
 assert.throws(()=>motanScalarNorm2([[3n<<510n],[3n<<510n]]),/finite range/);
 assert.throws(()=>motanScalarNorm2([[1n],[0n]],-1),/budget/);
 assert.equal(motanScalarNorm2([[3n],[4n]],8)[0],5);
});
test('integer norm flows through worker, downstream derivative and no-Python CSV with original Python results',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-norm-')),prefix=join(dir,'log'),executor=new MotanAnalysisExecutor();
 try{
  const base=(1n<<53n)+1n;await managerFixture(prefix,2,'corexy',round=>({a:base+BigInt(round+2),b:4n,yes:true}));
  const norm='norm2(status(export_fields.a),status(export_fields.b),status(export_fields.yes))',derivative=`derivative(${norm})`,columns=[norm,derivative];
  const result=await executor.analyze({prefix,datasets:columns,output:'table',preserveNumberTypes:true,duration:5,segmentTime:.01});
  assert.ok(result.datasets[norm] instanceof Float64Array);assert.ok(result.datasets[derivative] instanceof Float64Array);
  const root=fileURLToPath(new URL('../../',import.meta.url)),args=[prefix,'-c',JSON.stringify(columns),'--duration','5','--segment-time','.01'];
  const node=execFileSync(process.execPath,[join(root,'scripts/motan/data_export.ts'),...args,'--preserve-number-types'],{encoding:'utf8',env:{...process.env,PATH:'/no-programs'},timeout:10000});
  const python=execFileSync('python3',[join(root,'scripts/motan/data_export.py'),...args],{encoding:'utf8',env:scipyReferenceEnvironment(),timeout:10000});
  const rows=(csv:string)=>csv.trimEnd().split('\r\n').slice(1).map(row=>row.split(',').map(Number));
  assert.deepEqual(rows(node),rows(python));assert.deepEqual(rows(node),Array.from(result.times,(time,i)=>[time,...columns.map(name=>result.datasets[name][i])]));
 }finally{await executor.close();await rm(dir,{recursive:true,force:true});}
});
