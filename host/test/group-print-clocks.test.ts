import test from 'node:test';
import assert from 'node:assert/strict';
import {ClockSync} from '../src/timing/clock-sync.ts';
import {captureGroupPrintClocks} from '../src/timing/group-print-clocks.ts';
import {snapshotPrintClock} from '../src/timing/print-clock.ts';
import type {MCUGroup} from '../src/runtime/mcu-group.ts';
function fixture(reverse=false){
 const clocks=new Map([['main',new ClockSync(1e6,1000000n,10)],['aux',new ClockSync(2e6,10000000n,10)]]);
 const group={assertActive(){},status:{devices:(reverse?['aux','main']:['main','aux']).map(id=>({id}))},session(id:string){const sync=clocks.get(id);if(!sync)throw new Error('Unknown MCU');return {clock:{sync}};}} as unknown as MCUGroup;
 return {group,clocks};
}
for(const reverse of [false,true])test(`captured group clocks align distinct origins and frequencies (${reverse})`,()=>{
 const f=fixture(reverse),captured=captureGroupPrintClocks(f.group,'main',10);
 assert.equal(captured.size,2);assert.equal(captured.get('main')!.currentPrintTime,1);assert.equal(captured.get('aux')!.currentPrintTime,1);
 assert.equal(captured.get('main')!.calibration.frequency,1e6);assert.equal(captured.get('aux')!.calibration.frequency,2e6);
 assert.equal(snapshotPrintClock(captured.get('aux')!.calibration).clockAt(2),12000000n);
 const before=structuredClone(captured.get('aux'));f.clocks.get('aux')!.accept({clock32:12000000,sentTime:11,receiveTime:11.002},true);assert.deepEqual(captured.get('aux'),before);assert(Object.isFrozen(captured.get('aux')!.calibration));
});
test('capture rejects inactive, unknown and inexact clocks',()=>{
 const f=fixture();assert.throws(()=>captureGroupPrintClocks(f.group,'missing',10),/Unknown/);assert.throws(()=>captureGroupPrintClocks(f.group,'main',NaN),/time/);
 f.clocks.set('aux',new ClockSync(1e6,2n**60n,10));assert.throws(()=>captureGroupPrintClocks(f.group,'main',10),/exact/);
 f.clocks.set('aux',new ClockSync(2e6,10000000n,10));for(let i=0;i<5;i++)f.clocks.get('aux')!.querySent();assert.throws(()=>captureGroupPrintClocks(f.group,'main',10),/inactive/);
});
