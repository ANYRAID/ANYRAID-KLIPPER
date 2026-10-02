// Probe Z homing coordinate reset from klippy/extras/homing.py.
// GPL-3.0-or-later. Preserve original subtraction order and physical overshoot.
export function probeHomingPosition(halt:readonly number[],trigger:readonly number[],offset:number):number[]{
 if(halt.length<4||halt.length!==trigger.length||![...halt,...trigger,offset].every(Number.isFinite))throw new RangeError('Invalid probe homing coordinates');
 const result=[...halt];result[2]-=trigger[2]-offset;
 if(!Number.isFinite(result[2]))throw new RangeError('Probe homing coordinate overflow');return result;
}
