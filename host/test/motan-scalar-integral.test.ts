import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {motanScalarIntegral,type MotanScalarSeries} from '../src/motan/scalar-math.ts';
import {scalarOracle,scalarBits} from './helpers/motan-scalar-oracle.ts';
import {MotanAnalysisExecutor} from '../src/motan/analysis-executor.ts';
import {managerFixture} from './helpers/motan-manager-fixture.ts';
import {scipyReferenceEnvironment} from './helpers/motan-sos-oracle.ts';
test('integer integral retains exact mean division and CPython mixed sum transition order',()=>{
 const b=1n<<53n,wide=1n<<63n;
 const cases:MotanScalarSeries[]=[[b,b,b+3n],[-b,-b,-b-3n],[1n<<1023n,1n<<1023n,1n<<1023n],[true,false,true],
  [0,1e16,1n,-1e16],[0,1e16,1,-1e16],[wide,-wide,1e16,1,-1e16],
  [wide-1n,1n,-wide,1e16,1,-1e16],[0,1e16,1,wide,-wide,-1e16],
  [0,true,1e16,false,-1e16],[-0,0n,false,true],[0n]];
 for(const exponent of [0n,20n,52n,53n,63n,100n,511n,900n,1023n]){const base=1n<<exponent;cases.push([base,base,base+3n],[-base,-base,-base-3n],[base,-base,3n,1n,-1n]);}
 let seed=671;const random=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0;
 for(let k=0;k<32;k++)cases.push(Array.from({length:13},(_,i)=>i%3===0?(BigInt(random())<<BigInt(random()%90))*BigInt(i%2?-1:1):k%2===0?BigInt(random()):random()/65536));
 for(const data of cases)assert.deepEqual(scalarBits(motanScalarIntegral(data,.125,undefined,.015,64*1024**2,true)),scalarOracle('integral',data,undefined,.125).values);
 assert.deepEqual(Array.from(motanScalarIntegral([b,b,b+3n],1)),[0,0,4]);
 assert.notEqual(Number(3n*b+3n)/3,Number(b));
 assert.deepEqual(Array.from(motanScalarIntegral([1n<<1023n,1n<<1023n],1)),[0,0]);
});
test('integral reference deltas remain exact before float scaling, including mixed endpoints in typed mode',()=>{
 const b=1n<<100n;
 const pairs:[MotanScalarSeries,MotanScalarSeries][]=[[[1n,2n,4n,8n],[b,b+1n,b+3n,b+7n]],[[true,false,true,false],[false,true,false,true]],[[.5,1,2,4],[b,b+2n,b+3n,b+5n]],[[b,b+1n,b+3n,b+7n],[1,2n,3n,4n]]];
 for(const [data,ref]of pairs)for(const half of [0,.015,.5])assert.deepEqual(scalarBits(motanScalarIntegral(data,.01,ref,half,64*1024**2,true)),scalarOracle('integral',data,ref,.01,false,undefined,[String(half)]).values);
});
test('integral rejects ambiguous mixed sums, invalid resources and overflow without returning partial data',()=>{
 assert.throws(()=>motanScalarIntegral([1n,2],1),/Ambiguous/);
 assert.throws(()=>motanScalarIntegral([true,2],1),/Ambiguous/);
 assert.throws(()=>motanScalarIntegral([1n,2n],1,[1n,2]),/Ambiguous/);
 for(const data of [[],[null],['1'],[Infinity],[NaN]] as MotanScalarSeries[])assert.throws(()=>motanScalarIntegral(data,1));
 for(const segment of [0,-1,Infinity,NaN])assert.throws(()=>motanScalarIntegral([1n],segment));
 assert.throws(()=>motanScalarIntegral([1n],1,[1n,2n]),/reference/);
 assert.throws(()=>motanScalarIntegral([1n],1,undefined,-1),/time/);
 assert.throws(()=>motanScalarIntegral([1n],1,undefined,.015,7),/memory/);
 assert.throws(()=>motanScalarIntegral([1n],1,undefined,.015,-1),/budget/);
 assert.throws(()=>motanScalarIntegral([1n<<2000n,-(1n<<2000n)],1),/finite/);
 assert.throws(()=>motanScalarIntegral([1n<<1023n,1n<<1023n,0],1,undefined,.015,64*1024**2,true),/finite/);
 assert.throws(()=>motanScalarIntegral([1n<<1023n,-(1n<<1023n)],4),/finite/);
 assert.equal(motanScalarIntegral([1n],1,undefined,.015,8).length,1);
});
test('typed integer and mixed integral flow through worker and no-Python CSV matching original Python',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-integral-')),prefix=join(dir,'log'),executor=new MotanAnalysisExecutor();
 try{
  const b=1n<<53n;await managerFixture(prefix,2,'corexy',round=>({a:b+BigInt(round*3+1),ref:b+BigInt(round+1),mixed:round===0?1.25:b+BigInt(round+1)}));
  const source='integral(status(export_fields.a))',reference='integral(status(export_fields.a),status(export_fields.ref),0)',mixed='integral(status(export_fields.mixed))',columns=[source,reference,mixed];
  const result=await executor.analyze({prefix,datasets:columns,output:'table',preserveNumberTypes:true,duration:5,segmentTime:.01});
  for(const name of columns)assert.ok(result.datasets[name] instanceof Float64Array);
  await assert.rejects(executor.analyze({prefix,datasets:[mixed],output:'table',duration:5,segmentTime:.01}),/Ambiguous/);
  const root=fileURLToPath(new URL('../../',import.meta.url)),args=[prefix,'-c',JSON.stringify(columns),'--duration','5','--segment-time','.01'];
  const node=execFileSync(process.execPath,[join(root,'scripts/motan/data_export.ts'),...args,'--preserve-number-types'],{encoding:'utf8',env:{...process.env,PATH:'/no-programs'},timeout:10000});
  const python=execFileSync('python3',[join(root,'scripts/motan/data_export.py'),...args],{encoding:'utf8',env:scipyReferenceEnvironment(),timeout:10000});
  const rows=(csv:string)=>csv.trimEnd().split('\r\n').slice(1).map(row=>row.split(',').map(Number));
  assert.deepEqual(rows(node),rows(python));assert.deepEqual(rows(node),Array.from(result.times,(time,i)=>[time,...columns.map(name=>result.datasets[name][i])]));
 }finally{await executor.close();await rm(dir,{recursive:true,force:true});}
});
