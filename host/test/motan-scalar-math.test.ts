import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {motanScalarDerivative,motanScalarCombine} from '../src/motan/scalar-math.ts';
import {scalarOracle,scalarBits} from './helpers/motan-scalar-oracle.ts';
import {MotanAnalysisExecutor} from '../src/motan/analysis-executor.ts';
import {managerFixture} from './helpers/motan-manager-fixture.ts';

test('scalar arithmetic matches Python types and bits across integer cancellation and boolean series',()=>{
 const base=1n<<100n;
 const cases=[{a:[base,base+1n,base+3n,base-7n],b:[base-1n,base,base+7n,base-9n]},
  {a:[true,false,true,true],b:[false,true,false,true]},
  {a:[1.5,false,2.25,true],b:[false,2.5,true,0.5]},
  {a:[base,true,base+1n,false],b:[base,false,base+1n,true]}];
 for(const {a,b}of cases){
  assert.deepEqual(scalarBits(motanScalarDerivative(a,.003)),scalarOracle('derivative',a,undefined,.003).values);
  for(const kind of ['deviation','corexy_x','corexy_y'] as const)assert.deepEqual(scalarBits(motanScalarCombine(a,b,kind)),scalarOracle(kind,a,b).values);
 }
 const enormous=1n<<2000n;
 assert.deepEqual(Array.from(motanScalarDerivative([enormous,enormous+1n,enormous+3n],.5)),[2,2,4]);
 assert.equal(Number(base+1n)-Number(base),0);assert.equal(motanScalarDerivative([base,base+1n],1)[0],1);
 const residual=motanScalarCombine([base,base+1n,base+3n],[base,base,base],'deviation');
 assert.deepEqual(residual,[0n,1n,3n]);assert.deepEqual(Array.from(motanScalarDerivative(residual,1)),[1,1,2]);
});
test('scalar kernels reject ambiguous integer/float provenance, overflow, invalid input and result budgets',()=>{
 const base=1n<<100n;
 assert.throws(()=>motanScalarDerivative([base,1],1),/Ambiguous mixed/);
 assert.throws(()=>motanScalarCombine([base],[1],'deviation'),/Ambiguous mixed/);
 assert.throws(()=>motanScalarDerivative([null,null],1),/numeric scalars/);
 assert.throws(()=>motanScalarCombine(['1'],[1],'deviation'),/numeric scalars/);
 assert.throws(()=>motanScalarDerivative([true],1),/derivative/);
 assert.throws(()=>motanScalarDerivative([0n,1n<<2000n],1),/finite range/);
 assert.throws(()=>motanScalarCombine([1n<<2000n],[1n],'corexy_x'),/finite range/);
 assert.throws(()=>motanScalarCombine([base],[0n],'deviation',8),/memory limit/);
 assert.throws(()=>motanScalarCombine([1n],[0n],'deviation',0),/memory limit/);
});
test('worker mixed analysis preserves exact residual types through chained derivatives',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-scalar-analysis-')),prefix=join(dir,'log'),executor=new MotanAnalysisExecutor();
 try{
  const base=1n<<100n;await managerFixture(prefix,2,'corexy',round=>({a:base+BigInt(round+2),b:base,yes:true,no:false}));
  const difference='deviation(status(export_fields.a),status(export_fields.b))',derivative=`derivative(${difference})`,core='corexy(y,status(export_fields.a),status(export_fields.b))',bool='deviation(status(export_fields.yes),status(export_fields.no))';
  const result=await executor.analyze({prefix,datasets:[difference,derivative,core,bool],output:'table',duration:5,segmentTime:.01});
  assert.deepEqual([...new Set(result.datasets[difference])],[1n,2n,3n]);
  assert.deepEqual(Array.from(result.datasets[derivative]).filter(v=>v!==0),[100,100]);
  assert.deepEqual([...new Set(result.datasets[core])],[.5,1,1.5]);
  assert.ok(Array.from(result.datasets[bool]).every(v=>v===1n));
  const columns=[difference,derivative,core,bool],cli=fileURLToPath(new URL('../../scripts/motan/data_export.ts',import.meta.url));
  const csv=execFileSync(process.execPath,[cli,prefix,'-c',JSON.stringify(columns),'--duration','5','--segment-time','.01'],{encoding:'utf8',env:{...process.env,PATH:'/no-programs'},timeout:10000});
  const rows=csv.trimEnd().split('\r\n').slice(1).map(row=>row.split(','));
  assert.deepEqual(rows,Array.from(result.times,(time,i)=>[String(time),...columns.map(name=>String(result.datasets[name][i]))]));
 }finally{await executor.close();await rm(dir,{recursive:true,force:true});}
});
