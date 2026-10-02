import {ScheduledCoolingFan} from './fan.ts';
import {OutputBoundaryTimeline} from './output-boundaries.ts';
/** Part-fan cancellation requires a zero shutdown default. */
export class FanBoundaryTimeline extends OutputBoundaryTimeline {
 constructor(fan:ScheduledCoolingFan,capacity=Math.min(1024,fan.capacity)){
  super(fan,capacity,signal=>fan.off(signal));
 }
}
