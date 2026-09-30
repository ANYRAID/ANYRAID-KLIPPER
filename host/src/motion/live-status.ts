// Requested motion at MCU print time; see klippy/extras/motion_report.py.
import type {TrapQueue} from './trap-queue.ts';
import type {PlannedQueue} from './planned-queue.ts';
/** Read one retained C trapq phase. This is not measured encoder motion and
 * does not include input shaping or pressure-advance stepper corrections. */
export function sampleTrapMotion(queue:TrapQueue,printTime:number){
 if(!Number.isFinite(printTime)||printTime<0)throw new RangeError('Invalid motion observation time');
 const row=queue.extract(1,0,printTime);if(!row.length)return null;
 const relative=printTime-row[0],time=Math.max(0,Math.min(row[1],relative));
 const distance=(row[2]+.5*row[3]*time)*time;
 return {position:[row[4]+row[7]*distance,row[5]+row[8]*distance,row[6]+row[9]*distance],velocity:relative>=0&&relative<=row[1]?row[2]+row[3]*time:0};
}
export function liveMotionStatus(routes:readonly PlannedQueue[],printTime:number,extrusionAxis:number){
 if(!Number.isSafeInteger(extrusionAxis)||extrusionAxis<3)throw new RangeError('Invalid live extrusion axis');
 const xyz=routes.find(r=>r.extrusionAxis===undefined&&r.stationaryPosition===undefined);
 const extruder=routes.find(r=>r.extrusionAxis===extrusionAxis&&r.stationaryPosition===undefined);
 const motion=xyz?sampleTrapMotion(xyz.queue,printTime):null,e=extruder?sampleTrapMotion(extruder.queue,printTime):null;
 return {live_position:motion&&e?[...motion.position,e.position[0]]:null,live_velocity:motion?.velocity??null,live_extruder_velocity:e?.velocity??null};
}
