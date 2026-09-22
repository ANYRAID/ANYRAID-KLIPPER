import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {motanScalarDerivative,motanScalarCombine,type MotanScalarSeries} from '../src/motan/scalar-math.ts';
import {scalarOracle,scalarBits} from './helpers/motan-scalar-oracle.ts';
import {MotanAnalysisExecutor} from '../src/motan/analysis-executor.ts';
import {managerFixture} from './helpers/motan-manager-fixture.ts';
const budget=64*1024**2;
test('known mixed arithmetic matches Python operand conversion, result types and Float64 bits',()=>{
 const base=(1n<<53n)+1n;
 const cases:[MotanScalarSeries,MotanScalarSeries][]=[[[base,base,base,base],[1n,1.0,Number(base),-1.25]],[[0n,-0,0,false],[0,-0,0n,true]],[[true,false,1n,2.5],[1.25,2n,false,1n]],[[1n<<100n,(1n<<100n)+1n,1e30,0n],[1e30,1n<<100n,(1n<<100n)+1n,-0]]];
 let seed=703;const random=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0;
 const make=()=>Array.from({length:2048},(_,i)=>i%3===0?Boolean(random()%2):i%3===1?(BigInt(random())<<BigInt(random()%450))*BigInt(i%2?-1:1):random()/65536);
 cases.push([make(),make()]);
 for(const [a,b]of cases){
  assert.deepEqual(scalarBits(motanScalarDerivative(a,.003,true)),scalarOracle('derivative',a,undefined,.003).values);
  for(const kind of ['deviation','corexy_x','corexy_y'] as const)assert.deepEqual(scalarBits(motanScalarCombine(a,b,kind,budget,true)),scalarOracle(kind,a,b).values);
 }
 assert.deepEqual(motanScalarCombine([base,base],[1n,1],'deviation',budget,true),[base-1n,Number(base)-1]);
 const huge=1n<<2000n;assert.deepEqual(motanScalarCombine([huge],[huge-1n],'deviation',budget,true),[1n]);
 assert.equal(motanScalarCombine([huge],[huge-1n],'corexy_y',budget,true)[0],.5);
 assert.deepEqual(Array.from(motanScalarDerivative([huge,huge+1n],1,true)),[1,1]);
});
test('mixed arithmetic requires known types, checks both conversions and keeps result budgets',()=>{
 const huge=1n<<2000n;
 assert.throws(()=>motanScalarDerivative([1n,1],1),/Ambiguous/);
 assert.throws(()=>motanScalarCombine([1n],[1],'deviation'),/Ambiguous/);
 assert.throws(()=>motanScalarDerivative([huge,1],1,true),/finite/);
 for(const kind of ['deviation','corexy_x','corexy_y'] as const){
  assert.throws(()=>motanScalarCombine([huge],[1],kind,budget,true),/finite/);
  assert.throws(()=>motanScalarCombine([1],[huge],kind,budget,true),/finite/);
 }
 assert.throws(()=>motanScalarCombine([1n],[1],'deviation',7,true),/memory/);
 assert.equal(motanScalarCombine([1n],[1],'deviation',8,true)[0],0);
 assert.throws(()=>motanScalarCombine([1n],[0n],'deviation',8,true),/memory/);
 assert.throws(()=>motanScalarDerivative([1,2],1,'true' as unknown as boolean),/type mode/);
 assert.throws(()=>motanScalarCombine([1],[2],'deviation',budget,1 as unknown as boolean),/combination/);
});
test('typed mixed status differences, derivatives and CoreXY work through worker and no-Python CSV',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-mixed-arithmetic-')),prefix=join(dir,'log'),executor=new MotanAnalysisExecutor();
 try{
  const base=1n<<100n;await managerFixture(prefix,2,'corexy',round=>({a:base+BigInt(round*2+3),b:round===0?Number(base):base+BigInt(round===1?1:0)}));
  const a='status(export_fields.a)',b='status(export_fields.b)',difference=`deviation(${a},${b})`,derivative=`derivative(${difference})`,x=`corexy(x,${a},${b})`,y=`corexy(y,${a},${b})`,columns=[difference,derivative,x,y];
  const request={prefix,datasets:columns,output:'table' as const,duration:5,segmentTime:.01,preserveNumberTypes:true};
  const result=await executor.analyze(request);assert.deepEqual([...new Set(result.datasets[difference])],[1n,0,4n]);
  assert.deepEqual(Array.from(result.datasets[derivative]).filter(value=>value!==0),[-100,400]);
  await assert.rejects(executor.analyze({...request,preserveNumberTypes:false}),/Ambiguous/);
  const root=fileURLToPath(new URL('../../',import.meta.url)),args=[prefix,'-c',JSON.stringify(columns),'--duration','5','--segment-time','.01'];
  const node=execFileSync(process.execPath,[join(root,'scripts/motan/data_export.ts'),...args,'--preserve-number-types'],{encoding:'utf8',env:{...process.env,PATH:'/no-programs'},timeout:10000});
  const python=execFileSync('python3',[join(root,'scripts/motan/data_export.py'),...args],{encoding:'utf8',timeout:10000});
  const rows=(csv:string)=>csv.trimEnd().split('\r\n').slice(1).map(row=>row.split(',').map(Number));
  assert.deepEqual(rows(node),rows(python));assert.deepEqual(rows(node),Array.from(result.times,(time,i)=>[time,...columns.map(name=>Number(result.datasets[name][i]))]));
 }finally{await executor.close();await rm(dir,{recursive:true,force:true});}
});
test('status type mode does not misclassify unannotated raw integer datasets as floats',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-mixed-origin-')),prefix=join(dir,'log'),executor=new MotanAnalysisExecutor();
 try{
  const wide=(1n<<53n)+1n;await managerFixture(prefix,2,'corexy',{wide});
  const status='status(export_fields.wide)',phase='step_phase(tmc2209 stepper_x)',sg='stallguard(stepper_x,sg_result)',raw=[`deviation(${status},${phase})`,`deviation(${status},${sg})`];
  const root=fileURLToPath(new URL('../../',import.meta.url));
  const python=execFileSync('python3',[join(root,'scripts/motan/data_export.py'),prefix,'-c',JSON.stringify(raw),'-d','.02','--segment-time','.01'],{encoding:'utf8',timeout:10000});
  const first=python.split('\r\n')[1].split(',');assert.equal(BigInt(first[1]),wide-36n);assert.equal(BigInt(first[2]),wide-100n);
  for(const name of raw)await assert.rejects(executor.analyze({prefix,datasets:[name],output:'table',preserveNumberTypes:true,duration:.02,segmentTime:.01}),/Ambiguous/);
  // A derivative is known to produce floats even when its raw input is not
  // annotated. That information survives the DAG and permits safe mixing.
  const derived=`deviation(${status},derivative(${phase}))`,result=await executor.analyze({prefix,datasets:[derived],output:'table',preserveNumberTypes:true,duration:.02,segmentTime:.01});
  assert.ok(result.datasets[derived] instanceof Float64Array);assert.ok(Array.from(result.datasets[derived]).every(value=>value===Number(wide)));
 }finally{await executor.close();await rm(dir,{recursive:true,force:true});}
});
