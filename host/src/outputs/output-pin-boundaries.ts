import {OutputBoundaryTimeline} from './output-boundaries.ts';
import {ScheduledOutputPin} from './output-pin.ts';
/** Values retain their configured user scale until the scheduler admits them. */
export class OutputPinBoundaryTimeline extends OutputBoundaryTimeline {
 #pin:ScheduledOutputPin;
 constructor(pin:ScheduledOutputPin,capacity=Math.min(1024,pin.capacity)){super(pin,capacity);this.#pin=pin;}
 override register(value:number):number{this.#pin.validateValue(value);return super.register(value);}
}
