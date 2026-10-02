import type {StepHistory} from './step-history.ts';
import type {StepperPosition} from './stepper-position.ts';
/** Reconstruct accepted pulse history at an MCU clock, not an admission endpoint.
 * Undefined means the retained generation cannot prove coverage at that tick.
 * No direction inversion here: StepHistory and StepperPosition already use the
 * compressor's logical step direction. Not a physical encoder measurement. */
export function observedStepperPosition(history:StepHistory,position:StepperPosition,tick:bigint):number|undefined{
 if(typeof tick!=='bigint'||tick<0n||tick>0x7fffffffffffffffn)throw new RangeError('Invalid observed step clock');
 const steps=history.observedAt(tick);
 return steps===undefined?undefined:position.commandedPosition(steps);
}
