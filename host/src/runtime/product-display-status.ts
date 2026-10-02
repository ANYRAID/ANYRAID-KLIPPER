import type {PrintState} from '../operations/print.ts';
import type {DisplayStatus} from '../gcode/display-status.ts';
/** The product lifecycle owns whether a job remains active. A paused job keeps
 * slicer progress; terminal/idle states expire it using the normal five seconds.
 * This does not synthesize an idle_timeout device or claim physical activity. */
export function productDisplayStatus(display:DisplayStatus,state:PrintState,fileProgress:number,eventtime:number){
 const active=['preparing','printing','pausing','paused','resuming','finishing','cancelling'].includes(state);
 return display.status(eventtime,active,fileProgress);
}
