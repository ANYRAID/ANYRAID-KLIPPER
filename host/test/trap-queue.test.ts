import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {Move,LookAheadQueue,motionLimits} from '../src/motion/lookahead.ts';
function planned():Move[] {
  const queue=new LookAheadQueue(),move=new Move(motionLimits(100,1000),[0,0,0,0],[100,0,0,2],100);
  queue.add(move);return queue.flush();
}
test('planned XYZ motion reaches the original endpoint in the actual C queue',()=>{
  const queue=new TrapQueue();try {
    const moves=planned(),end=queue.appendPlanned(moves,1),data=queue.extract(10,0,end+1);
    assert.equal(data.length,30);
    const position=data[4]+data[7]*(data[2]+.5*data[3]*data[1])*data[1];
    assert.ok(Math.abs(position-100)<1e-12);
    assert.ok(Math.abs(data[0]+data[1]-end)<1e-12);
    queue.finalize(end+1,0);assert.deepEqual(queue.extract(10,0,end+1),data);
  } finally {queue.dispose();}
});
test('extruder queue preserves ratio and pressure advance eligibility',()=>{
  const queue=new TrapQueue();try {
    const end=queue.appendPlanned(planned(),1,3),data=queue.extract(10,0,end+1);
    assert.equal(data[7],1);assert.equal(data[8],1);
    assert.ok(Math.abs(data[4]+(data[2]+.5*data[3]*data[1])*data[1]-2)<1e-12);
  } finally {queue.dispose();}
});
test('native batch validation is atomic, rejects shared buffers and protects disposed handles',()=>{
  const queue=new TrapQueue();
  const rows=new Float64Array([1,0,1,0,0,0,0,1,0,0,1,1,1, 2,0,-1,0,1,0,0,1,0,0,1,1,1]);
  assert.throws(()=>queue.appendRaw(rows),/invalid motion time/);
  assert.equal(queue.extract(10,0,10).length,0);
  assert.throws(()=>queue.appendRaw(new Float64Array(new SharedArrayBuffer(13*8))),/Invalid motion batch/);
  queue.appendRaw(rows.subarray(0,13));
  assert.throws(()=>queue.appendRaw(rows.subarray(0,13)),/Overlapping/);
  queue.dispose();queue.dispose();assert.throws(()=>queue.extract(1,0,10),/closed/);
  const native=createRequire(import.meta.url)(process.env.ANYRAID_TRAPQ_ADDON??'../build/trapq.node');
  assert.throws(()=>native.append({},new Float64Array()),/Invalid trapq handle/);
});
test('position reset truncates future motion and resumes from the supplied coordinate',()=>{
  const queue=new TrapQueue();try {
    queue.appendRaw(new Float64Array([1,0,10,0,0,0,0,1,0,0,1,1,0]));
    queue.setPosition(5,50,2,3);
    const history=queue.extract(10,0,20);
    assert.deepEqual([...history.subarray(0,10)],[5,0,0,0,50,2,3,0,0,0]);
    assert.equal(history[10],1);assert.equal(history[11],4);
    queue.appendRaw(new Float64Array([5,0,1,0,50,2,3,1,0,0,2,2,0]));
    const newest=queue.extract(1,0,20);
    assert.equal(newest[4]+newest[2]*newest[1],52);
  } finally {queue.dispose();}
});
test('reset and cleanup reject rewinding finalized state without changing history',()=>{
  const queue=new TrapQueue();try {
    queue.setPosition(5,1,2,3);const before=queue.extract(10,0,10);
    assert.throws(()=>queue.setPosition(4,0,0,0),/precedes/);
    assert.throws(()=>queue.setPosition(6,NaN,0,0),/Nonfinite/);
    assert.throws(()=>queue.finalize(4,0),/cleanup/);
    assert.deepEqual(queue.extract(10,0,10),before);
  } finally {queue.dispose();}
});
test('repeated native queue creation, reset, history cleanup and disposal',()=>{
  for(let i=0;i<1000;i++) {
    const queue=new TrapQueue();queue.appendPlanned(planned(),1);
    queue.setPosition(1.5,i,0,0);queue.finalize(2,1.5);queue.extract(10,0,10);
    queue.dispose();queue.dispose();
  }
});
