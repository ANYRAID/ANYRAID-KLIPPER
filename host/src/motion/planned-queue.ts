import type {TrapQueue} from './trap-queue.ts';
export interface PlannedQueue {queue:TrapQueue;extrusionAxis?:number;stationaryPosition?:readonly [number,number,number]}
/** Fixed routes retain full coordinator ownership during independent motor adjustment. */
export function plannedQueuePosition(r:PlannedQueue,position:readonly number[]):readonly [number,number,number]{return r.stationaryPosition??(r.extrusionAxis===undefined?[position[0],position[1],position[2]]:[position[r.extrusionAxis],0,0]);}
