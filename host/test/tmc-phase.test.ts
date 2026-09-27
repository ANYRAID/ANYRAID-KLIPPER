import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {tmcPhaseOffset,TmcPhaseState} from '../src/drivers/tmc-phase.ts';
const reference=JSON.parse(readFileSync(new URL('../contracts/tmc-phase-reference.json',import.meta.url),'utf8')) as {offsetsU16LE:string;positions:{counter:number;microsteps:number;inverted:boolean;mcu:string;offset:number}[]};
test('all 18432 MSCNT, microstep and direction combinations match original Python',()=>{
 const bytes=Buffer.from(reference.offsetsU16LE,'base64');let index=0;
 for(const microsteps of [1,2,4,8,16,32,64,128,256])for(const inverted of [false,true])for(let counter=0;counter<1024;counter++){
  const phase=tmcPhaseOffset(counter,microsteps,inverted,0n);assert.equal(phase.offset,bytes.readUInt16LE(index++*2));assert.equal(phase.phase,phase.offset);assert.equal(phase.phases,microsteps*4);
  assert.equal(tmcPhaseOffset(counter,microsteps,inverted,1n<<32n).offset,phase.offset);assert.equal(tmcPhaseOffset(counter,microsteps,inverted,-(1n<<32n)).offset,phase.offset);
 }
 assert.equal(index*2,bytes.length);
});
test('negative and beyond-Number MCU counts preserve exact Python modulo',()=>{
 for(const r of reference.positions)assert.equal(tmcPhaseOffset(r.counter,r.microsteps,r.inverted,BigInt(r.mcu)).offset,r.offset);
});
test('phase state invalidates unknown samples and cannot revive retired hardware',()=>{
 const state=new TmcPhaseState(16,false);assert.equal(state.sample,null);const first=state.synchronize(0,0n);assert(Object.isFrozen(first));assert.equal(state.changes,0);
 state.synchronize(0,64n);assert.equal(state.changes,0);const changed=state.synchronize(0,1n);assert.equal(state.changes,1);assert.notEqual(changed.offset,first.offset);assert.deepEqual(state.sample,changed);
 assert.throws(()=>state.synchronize(1024,0n));assert.equal(state.sample,null);state.synchronize(512,0n);state.invalidate();assert.equal(state.sample,null);
 state.synchronize(0,0n);state.retire();assert.equal(state.sample,null);assert.throws(()=>state.synchronize(0,0n),/retired/);
});
test('phase input validation rejects lossy or unsupported values',()=>{
 for(const counter of [-1,.5,1024,NaN,Infinity])assert.throws(()=>tmcPhaseOffset(counter,16,false,0n));
 for(const microsteps of [0,3,512,NaN,Infinity])assert.throws(()=>tmcPhaseOffset(0,microsteps,false,0n));
 assert.throws(()=>tmcPhaseOffset(0,16,0 as unknown as boolean,0n));assert.throws(()=>tmcPhaseOffset(0,16,false,1 as unknown as bigint));
});
