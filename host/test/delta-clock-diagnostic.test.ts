import test from 'node:test';
import assert from 'node:assert/strict';
import {deltaClockDiagnostic} from './helpers/delta-clock-diagnostic.ts';
import {ClockSync} from '../src/timing/clock-sync.ts';
import {PrintClockTimeline} from '../src/timing/print-clock-timeline.ts';
import {snapshotPrintClock} from '../src/timing/print-clock.ts';
test('clock diagnostic retains historical trigger conversion and owns detached observations',()=>{
 const initial=[{offset:0,frequency:1e6},{offset:.001,frequency:1000123.5}];
 const configurations=initial.map((calibration,physicalMember)=>({
  mcu:physicalMember?'aux':'mcu',physicalMember,timeline:new PrintClockTimeline(calibration),
  session:{clock:{sync:new ClockSync(1e6,1000000n,0)}},
 }));
 configurations[0].timeline.append(2000000n,999000);
 configurations[1].timeline.append(1000000n,1005000);
 // The primary is physically member 1 even when configuration order reverses.
 const printer={hardware:{plan:{configurations:[configurations[1],configurations[0]]}}} as unknown as Parameters<typeof deltaClockDiagnostic>[0];
 const before=configurations.map(c=>({timeline:c.timeline.status,revision:c.session.clock.sync.revision}));
 const hit=800000,old=snapshotPrintClock(initial[1]),printTime=old.printTimeAtClock(BigInt(hit));
 const result=deltaClockDiagnostic(printer,1,hit);
 assert.equal(result.primary,'aux');assert.equal(result.printTime,printTime);
 assert.equal(result.members[0].mappedTrigger,BigInt(hit));
 assert.equal(result.members[1].mappedTrigger,snapshotPrintClock(initial[0]).clockAt(printTime));
 assert.notEqual(result.printTime,snapshotPrintClock(configurations[1].timeline.status.calibration).printTimeAtClock(BigInt(hit)));
 assert.deepEqual(configurations.map(c=>({timeline:c.timeline.status,revision:c.session.clock.sync.revision})),before);
 // Later calibration and edits to a returned observation cannot rewrite it.
 const retained=structuredClone(result);
 configurations[1].timeline.append(1500000n,1006000);
 assert.deepEqual(result,retained);
 result.members[0].timeline.calibration.offset=99;
 assert.notEqual(configurations[1].timeline.status.calibration.offset,99);
});
test('retired clock history remains unavailable rather than replacing the failure with a current map',()=>{
 const timeline=new PrintClockTimeline({offset:0,frequency:1e6});timeline.append(1000000n,1001000);timeline.retireBefore(1000000n);
 const printer={hardware:{plan:{configurations:[{mcu:'mcu',physicalMember:0,timeline,session:{clock:{sync:new ClockSync(1e6,1000000n,0)}}}]}}} as unknown as Parameters<typeof deltaClockDiagnostic>[0];
 const before=timeline.status,result=deltaClockDiagnostic(printer,0,500000);
 assert.deepEqual(result.printTime,{unavailable:'RangeError: MCU tick outside retained clock history'});
 assert.equal(result.members[0].mappedTrigger,undefined);assert.deepEqual(timeline.status,before);
});
