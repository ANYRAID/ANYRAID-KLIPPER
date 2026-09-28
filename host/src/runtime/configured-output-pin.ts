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
 let started=false;
 return Object.freeze({settings:plan.settings,output:Object.freeze(output),async start(signal:AbortSignal){
  if(started)throw new Error('Output pin cannot restart');started=true;
  try{
   await output.runtime.reset(signal);signal.throwIfAborted();group.assertActive();
   // Configuration starts at the shutdown default. Apply the requested initial
   // value only after the hardware owner has finalized every MCU.
   if(plan.settings.initialValue!==plan.settings.shutdownValue){
    const now=plan.clock.printTimeAtClock(session.clock.sync.getClock(serialClock.now())),time=now+.2;
    if(!Number.isFinite(time)||time<=now)throw new RangeError('Invalid output pin startup time');
    if(output.kind==='digital')await output.runtime.setDigital(time,plan.settings.initialValue===1,signal);
    else await output.runtime.setPWM(output.runtime.nextAlignedPrintTime(time),plan.settings.initialValue,signal);
   }
  }catch(error){try{await output.runtime.stop(error);}catch(stopError){throw new AggregateError([error,stopError],'Output pin startup and stop failed');}throw error;}
 }});
}
