import type {MCUGroup} from '../runtime/mcu-group.ts';
import type {CompiledPWM} from '../outputs/pwm.ts';
import {GenerationPWMOutput} from '../outputs/generation-pwm.ts';
import {AsyncHeaterRuntime} from '../thermal/async-runtime.ts';
import type {readHeaterControlConfiguration} from '../thermal/heater-config.ts';
import type {ThermalTimer} from '../thermal/runtime.ts';
import type {PrintClockTimeline} from '../timing/print-clock-timeline.ts';
import {serialClock} from '../protocol/serial-queue.ts';
export interface HeaterOutputPlan {mcu:string;pwm:CompiledPWM;timeline?:PrintClockTimeline;clock:{clockAt(time:number):bigint;printTimeAtClock(clock:bigint):number};}
/** ADC and digital sources share the same acknowledged output, control math,
 * watchdog and generation retirement. The caller owns sensor subscriptions. */
export function createHeaterOutputRuntime(group:MCUGroup,p:HeaterOutputPlan,c:ReturnType<typeof readHeaterControlConfiguration>,sensorMcu:string,timer?:ThermalTimer){
 const outputSession=group.session(p.mcu),sensorSession=group.session(sensorMcu);let output:GenerationPWMOutput|undefined;
 const runtime=new AsyncHeaterRuntime(c.settings,c.control,{
  configuration:{cycleTime:p.pwm.cycleTime,maximumDuration:p.pwm.maximumDuration,initialPower:p.pwm.invert?1-p.pwm.startValue:p.pwm.startValue,defaultPower:p.pwm.invert?1-p.pwm.shutdownValue:p.pwm.shutdownValue},
  reset(signal){group.assertActive();outputSession.configuration;sensorSession.configuration;output??=p.timeline?GenerationPWMOutput.withClock(p.pwm,outputSession.dictionary,group.commandQueue(p.mcu),group.commandQueue(p.mcu),p.timeline):new GenerationPWMOutput(p.pwm,outputSession.dictionary,group.commandQueue(p.mcu),group.commandQueue(p.mcu),p.clock.clockAt,p.clock.printTimeAtClock);return output.reset(signal);},
  setPWM(time,power,signal){if(!output)throw new Error('Heater output not started');return output.setPWM(time,power,signal);},
  stop(cause){return output?output.stop(cause):group.stop(cause);},
 },()=>{const system=serialClock.now();return {system,print:p.clock.printTimeAtClock(outputSession.clock.sync.getClock(system))};},c.verification,timer);
 return {runtime,get outputStatus(){return output?.status;}};
}
