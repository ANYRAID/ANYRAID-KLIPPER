import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TrajectoryAudit,TrajectoryMismatch} from '../bench/trajectory-audit.ts';

test('exact audit writes nothing and never repeats native extraction on success',()=>{
 const root=mkdtempSync(join(tmpdir(),'trajectory-audit-test-'));try{const expected=new Float64Array(30);new TrajectoryAudit([expected]).check([expected.slice()],()=>{throw new Error('unexpected repeat');},{iteration:1,mode:'source'},root);assert.deepEqual(readdirSync(root),[]);}finally{rmSync(root,{recursive:true,force:true});}
});
test('audit snapshots only a typed view and ignores unrelated backing-buffer changes',()=>{
 const root=mkdtempSync(join(tmpdir(),'trajectory-audit-test-'));try{const backing=new Float64Array(30),slice=backing.subarray(10,20),audit=new TrajectoryAudit([slice]);backing[0]=123;backing[29]=456;audit.check([new Float64Array(10)],()=>{throw new Error('unexpected repeat');},{iteration:1,mode:'direct'},root);assert.deepEqual(readdirSync(root),[]);}finally{rmSync(root,{recursive:true,force:true});}
});
test('audit preserves subnormal mismatch bits and captures fresh native extraction',()=>{
 const root=mkdtempSync(join(tmpdir(),'trajectory-audit-test-'));try{
  const expected=new Float64Array(30),actual=expected.slice();new DataView(actual.buffer).setBigUint64(12*8,0x1000000n,true);let repeat=0;
  assert.throws(()=>new TrajectoryAudit([expected]).check([actual],()=>{repeat++;return [expected.slice()];},{iteration:7,mode:'source',fixture:()=>({startTime:1})},root),(error:unknown)=>{
   assert(error instanceof TrajectoryMismatch);const report=JSON.parse(readFileSync(join(error.directory,'report.json'),'utf8'));assert.equal(report.baselineChanged,false);assert.equal(report.snapshotChanged,false);assert.deepEqual(report.differences,[{queue:0,index:12,row:1,field:'startVelocity',expectedBits:'0x0000000000000000',actualBits:'0x0000000001000000',repeatBits:'0x0000000000000000'}]);assert.equal(readFileSync(join(error.directory,'actual-0.bin')).readBigUInt64LE(96),0x1000000n);assert.equal(report.records.length,4);assert.deepEqual(JSON.parse(readFileSync(join(error.directory,'fixture.json'),'utf8')),{startTime:1});return true;
  });assert.equal(repeat,1);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('audit detects mutation of the original reference even if actual matches that mutation',()=>{
 const root=mkdtempSync(join(tmpdir(),'trajectory-audit-test-'));try{const original=new Float64Array(10),audit=new TrajectoryAudit([original]);original[2]=1;assert.throws(()=>audit.check([original.slice()],()=>{throw new Error('repeat failed');},{iteration:1,mode:'direct'},root),(error:unknown)=>{assert(error instanceof TrajectoryMismatch);const report=JSON.parse(readFileSync(join(error.directory,'report.json'),'utf8'));assert.equal(report.baselineChanged,true);assert.match(report.repeatError,/repeat failed/);assert.equal(readFileSync(join(error.directory,'expected-0.bin')).readDoubleLE(16),0);return true;});}finally{rmSync(root,{recursive:true,force:true});}
});
test('audit rejects changed queue lengths and distinguishes negative zero bitwise',()=>{
 const root=mkdtempSync(join(tmpdir(),'trajectory-audit-test-'));try{const expected=new Float64Array(10),actual=expected.slice();actual[0]=-0;for(const queues of [[actual],[]])assert.throws(()=>new TrajectoryAudit([expected]).check(queues,()=>queues,{iteration:1,mode:'source'},root),TrajectoryMismatch);}finally{rmSync(root,{recursive:true,force:true});}
});
