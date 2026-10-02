/** Immutable peripheral clock mapping, independent of a disposable solver.
 * Matches StepCompressor's C-compatible positive half-up clock conversion. */
export function snapshotPrintClock(calibration:Readonly<{offset:number;frequency:number}>){
 const {offset,frequency}=calibration;
 if(!Number.isFinite(offset)||Math.abs(offset)>=1e15||!Number.isFinite(frequency)||frequency<=0||frequency>1e9)throw new RangeError('Invalid peripheral clock mapping');
 return Object.freeze({offset,frequency,
  clockAt(printTime:number):bigint{const raw=(printTime-offset)*frequency,rounded=Math.floor(raw+.5);if(!Number.isFinite(printTime)||!Number.isSafeInteger(rounded)||raw<0)throw new RangeError('Invalid print-time clock');return BigInt(rounded);},
  printTimeAtClock(clock:bigint):number{if(typeof clock!=='bigint'||clock<0n||clock>BigInt(Number.MAX_SAFE_INTEGER))throw new RangeError('Observed clock exceeds exact mapping range');const time=offset+Number(clock)/frequency;if(!Number.isFinite(time)||Math.abs(time)>=1e15)throw new RangeError('Invalid observed print time');return time;},
 });
}
