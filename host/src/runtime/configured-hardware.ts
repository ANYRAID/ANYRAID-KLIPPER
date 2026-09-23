import {compileConfiguredHardware,type HardwareLayout} from '../config/hardware.ts';
import {attachConfiguredAnalogHeater} from '../config/analog-heater.ts';
import type {FanClock} from '../config/cooling-fan.ts';
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {MCUGroup} from './mcu-group.ts';
import {AsyncPrinterHeaters} from '../thermal/async-heaters.ts';
import {GenerationPWMOutput} from '../outputs/generation-pwm.ts';
import {ScheduledCoolingFan} from '../outputs/fan.ts';
import {MotorEnable} from '../outputs/motor-enable.ts';
import {compileConfiguredMotionEmitters,type ConfiguredMotionRequest} from '../config/motion-emitters.ts';
const owners=new WeakSet<MCUGroup>();
export interface HardwareStartupOptions {
 /** The future motion owner must provide its admission barrier here. */
 beforeTarget:(signal:AbortSignal)=>void|Promise<void>;
 heaterGcodeIds?:Readonly<Record<string,string>>;
 timeoutMs?:number;
 motion?:readonly ConfiguredMotionRequest[];
}
/** Own an already connected MCU group for the rest of its lifetime. Planning
 * errors have no IO effects; after transfer every failure stops all devices.
 * Ready means configured, subscribed and reset to defaults, NOT homed, fresh
 * temperature, or authorized to print. Request cancellation covers startup
 * only; close() is the lifetime stop and is idempotent. */
export async function startConfiguredHardware(reader:ConfigurationReader,group:MCUGroup,clocks:ReadonlyMap<string,FanClock>,layout:HardwareLayout,options:HardwareStartupOptions,signal:AbortSignal){
 signal.throwIfAborted();group.assertActive();
 const timeout=options.timeoutMs??10000;
 if(owners.has(group)||typeof options.beforeTarget!=='function'||!Number.isSafeInteger(timeout)||timeout<1||timeout>300000)throw new Error('Invalid or reused hardware startup ownership');
 const plan=compileConfiguredHardware(reader,group,clocks,layout),ids={...options.heaterGcodeIds};
 const emitters=options.motion?compileConfiguredMotionEmitters(reader,plan,options.motion):undefined;
 if(Object.keys(ids).some(name=>!plan.heaters.some(h=>h.section===name)))throw new Error('Unknown heater G-code mapping');
 const heaters=new AsyncPrinterHeaters(options.beforeTarget),analog:ReturnType<typeof attachConfiguredAnalogHeater>[]=[];
 const fans:{section:string;runtime:ScheduledCoolingFan}[]=[],abort=new AbortController();
 let motorEnable:MotorEnable|undefined,state:'starting'|'ready'|'stopping'|'stopped'|'failed'='starting',fault:unknown,stopError:unknown,closing:Promise<void>|undefined,detach=()=>{};
 const close=(cause:unknown=new Error('Configured hardware closed')):Promise<void>=>{
  if(closing)return closing;const done=Promise.withResolvers<void>();closing=done.promise;state='stopping';fault=cause;abort.abort(cause);detach();
  const jobs:Promise<void>[]=[];
  // Start independent safety immediately; never wait for a graceful output
  // transaction before initiating the MCU stop. Callbacks must not await us.
  for(const stop of [()=>group.stop(cause),()=>heaters.shutdown('Configured hardware stopped'),...analog.map(a=>()=>a.stop(cause)),...fans.map(f=>()=>f.runtime.stop(cause))])try{jobs.push(Promise.resolve(stop()));}catch(error){jobs.push(Promise.reject(error));}
  void Promise.allSettled(jobs).then(results=>{const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length){state='failed';stopError=new AggregateError(errors,'Configured hardware stop failed',{cause});done.reject(stopError);}else{state='stopped';done.resolve();}});
  return closing;
 };
 owners.add(group);
 const cancelled=()=>{void close(signal.reason).catch(()=>{});};signal.addEventListener('abort',cancelled,{once:true});
 const timer=setTimeout(()=>{void close(new Error('Hardware startup timed out')).catch(()=>{});},timeout);
 const active=()=>{signal.throwIfAborted();abort.signal.throwIfAborted();group.assertActive();};
 try{
  detach=group.subscribeStop(cause=>{void close(cause).catch(()=>{});});active();
  for(const h of plan.heaters){const binding=attachConfiguredAnalogHeater(group,h);analog.push(binding);heaters.register(h.section,binding.runtime,ids[h.section]);}
  // No generation reset or output activation until EVERY MCU finalized.
  for(const c of plan.configurations){await c.session.configure(c.plan,abort.signal);active();}
  if(plan.steppers.length)motorEnable=new MotorEnable(group,plan.motors.lines,plan.motors.alwaysOn);
  const output=(p:typeof plan.fans[number]['output'])=>{const s=group.session(p.mcu);return new GenerationPWMOutput(p.pwm,s.dictionary,group.commandQueue(p.mcu),group.commandQueue(p.mcu),p.clock.clockAt,p.clock.printTimeAtClock);};
  for(const f of plan.fans){const runtime=new ScheduledCoolingFan(output(f.output),f.config,f.enable?output(f.enable):undefined);fans.push({section:f.section,runtime});await runtime.start(abort.signal);active();}
  await heaters.start(abort.signal);active();for(const a of analog){a.sensor.activate();active();}
  state='ready';
  return Object.freeze({plan,emitters,heaters,analog:Object.freeze(analog),fans:Object.freeze(fans.map(f=>Object.freeze(f))),motorEnable,close,get status(){return {state,fault,stopError};}});
 }catch(error){try{await close(error);}catch(cleanup){throw new AggregateError([error,cleanup],'Hardware startup and cleanup failed',{cause:error});}throw error;}
 finally{clearTimeout(timer);signal.removeEventListener('abort',cancelled);}
}
