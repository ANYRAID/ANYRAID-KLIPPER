import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeLinearFixture} from './helpers/native-linear-port.ts';
test('published phase position follows adopted coordinates and disappears on shutdown',async()=>{
 const t=await nativeLinearFixture();try{
  const before=t.port.phaseOffsetPosition('x',7)!;assert(Number.isFinite(before));
  t.f.fw.setTriggerReason(2,8);const next=[...t.port.homingPosition()];next[0]+=5;
  await t.port.forcePosition(next,new AbortController().signal);
  assert(Math.abs(t.port.phaseOffsetPosition('x',7)!-before-5)<1e-12);
  assert.throws(()=>t.port.phaseOffsetPosition('missing',7));assert.throws(()=>t.port.phaseOffsetPosition('x',1024));
  await t.port.motorOff(new Error('retired'));assert.equal(t.port.phaseOffsetPosition('x',7),null);
 }finally{await t.close();}
});
