import type {MotionBinding} from '../motion/coordinator.ts';
import type {StoppedEmitter} from './rebuild-motion.ts';
/** Runtime recovery preserves live filters and calibration, never stale startup
 * descriptors. Structural/clock ownership remains validated by recovery. */
export function recoveryEmitters(bindings:readonly MotionBinding[],emitters:readonly StoppedEmitter[]):StoppedEmitter[]{
 const byId=new Map(bindings.map(b=>[b.id,b]));
 if(byId.size!==bindings.length||bindings.length!==emitters.length||new Set(emitters.map(e=>e.id)).size!==emitters.length)throw new Error('Recovery filter ownership differs');
 return emitters.map(e=>{const b=byId.get(e.id);if(!b)throw new Error('Missing recovery filter owner');const {carriage:_carriage,shapers:_shapers,pressureAdvance:_pressure,...descriptor}=e,calibration=b.stepper.calibration;return {...structuredClone(descriptor),settings:{...e.settings,timeOffset:calibration.offset,frequency:calibration.frequency},...b.stepper.recoveryFilters()};});
}
