import {SERVO_SLACK} from '../config/servo.ts';
import {ScheduledOutputPin} from '../outputs/output-pin.ts';
import type {compileConfiguredOutputPins} from '../config/configured-output-pins.ts';
import {GenerationDigitalOutput} from '../outputs/generation-digital.ts';
import {GenerationPWMOutput} from '../outputs/generation-pwm.ts';
import {serialClock} from '../protocol/serial-queue.ts';
import type {MCUGroup} from './mcu-group.ts';

/** Internal device owner. Product commands still require motion admission. */
export function attachConfiguredOutputPin(group:MCUGroup,plan:ReturnType<typeof compileConfiguredOutputPins>[number]){
 const session=group.session(plan.mcu),data=group.commandQueue(plan.mcu),control=group.commandQueue(plan.mcu);
 const compiled=plan.output;
 const output=compiled.kind==='digital'
  ? {kind:'digital' as const,runtime:plan.timeline
   ? GenerationDigitalOutput.withClock(compiled.config,session.dictionary,data,control,plan.timeline)
   : new GenerationDigitalOutput(compiled.config,session.dictionary,data,control,plan.clock.clockAt)}
  : {kind:'pwm' as const,runtime:plan.timeline
   ? GenerationPWMOutput.withClock(compiled.config,session.dictionary,data,control,plan.timeline)
   : new GenerationPWMOutput(compiled.config,session.dictionary,data,control,plan.clock.clockAt,plan.clock.printTimeAtClock)};
 const slack=plan.settings.section.startsWith('servo ')?SERVO_SLACK:0;
 const runtime=new ScheduledOutputPin({
  reset:signal=>output.runtime.reset(signal),stop:cause=>output.runtime.stop(cause),
  align:time=>output.kind==='pwm'?output.runtime.nextAlignedPrintTime(time,slack):time,
  setValue:(time,value,signal)=>output.kind==='digital'?output.runtime.setDigital(time,value===1,signal):output.runtime.setPWM(time,value,signal),
 },plan.settings,.1,1024,slack);
 return Object.freeze({settings:plan.settings,output:Object.freeze(output),runtime,start(signal:AbortSignal){
  return runtime.start(()=>{
   group.assertActive();const now=plan.clock.printTimeAtClock(session.clock.sync.getClock(serialClock.now())),time=now+.2;
   if(!Number.isFinite(time)||time<=now)throw new RangeError('Invalid output pin startup time');return time;
  },signal);
 }});
}
