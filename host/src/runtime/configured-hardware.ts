import {compileConfiguredHardware,type HardwareLayout} from '../config/hardware.ts';
import {attachConfiguredAnalogHeater} from '../config/analog-heater.ts';
import type {FanClock} from '../config/cooling-fan.ts';
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {MCUGroup} from './mcu-group.ts';
import {AsyncPrinterHeaters} from '../thermal/async-heaters.ts';
import {GenerationPWMOutput} from '../outputs/generation-pwm.ts';
import {ScheduledCoolingFan} from '../outputs/fan.ts';
import {readHeaterFanPolicy} from '../thermal/heater-fan.ts';
import {HeaterFanRuntime,PeriodicFanRuntime} from '../thermal/heater-fan-runtime.ts';
import {readControllerFanPolicy,ControllerFanState} from '../thermal/controller-fan.ts';
import {serialClock} from '../protocol/serial-queue.ts';
import {MotorEnable} from '../outputs/motor-enable.ts';
import {SwitchInput} from '../inputs/switch-input.ts';
import {compileConfiguredMotionEmitters,type ConfiguredMotionRequest} from '../config/motion-emitters.ts';
const owners=new WeakSet<MCUGroup>();
const hardwareOwners=new WeakMap<object,{group:MCUGroup;claimed:boolean;beforeTarget?:(signal:AbortSignal)=>Promise<void>;cleanup:Set<(cause:unknown)=>Promise<void>>}>();
/** Attach product policy cleanup to every hardware stop, including MCU faults. */
export function registerConfiguredCleanup(hardware:Awaited<ReturnType<typeof startConfiguredHardware>>,cleanup:(cause:unknown)=>Promise<void>):void{
 const owner=hardwareOwners.get(hardware);if(!owner||hardware.status.state!=='ready')throw new Error('Hardware cleanup owner is not ready');owner.group.assertActive();owner.cleanup.add(cleanup);
}
/** Internal single-use motion handoff; cleanup must not await hardware.close(). */
export function claimConfiguredMotion(hardware:Awaited<ReturnType<typeof startConfiguredHardware>>,cleanup:(cause:unknown)=>Promise<void>,beforeTarget:(signal:AbortSignal)=>Promise<void>){
 const owner=hardwareOwners.get(hardware);if(!owner||owner.claimed||hardware.status.state!=='ready'||!hardware.emitters?.length||typeof cleanup!=='function'||typeof beforeTarget!=='function')throw new Error('Invalid or reused configured motion owner');owner.group.assertActive();owner.claimed=true;owner.beforeTarget=beforeTarget;owner.cleanup.add(cleanup);return owner.group;
}
export interface HardwareStartupOptions {
 /** Additional caller ordering; required only without managed motion. */
 beforeTarget?:(signal:AbortSignal)=>void|Promise<void>;
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
 if(owners.has(group)||(typeof options.beforeTarget!=='function'&&!(options.beforeTarget===undefined&&options.motion?.length))||!Number.isSafeInteger(timeout)||timeout<1||timeout>300000)throw new Error('Invalid or reused hardware startup ownership');
 const plan=compileConfiguredHardware(reader,group,clocks,layout),ids={...options.heaterGcodeIds};
 const thermalPolicies=new Map(plan.fans.filter(f=>f.section.startsWith('heater_fan ')).map(f=>[f.section,readHeaterFanPolicy(reader,f.section,plan.heaters.map(h=>h.section))]));
 const controllerPolicies=new Map(plan.fans.filter(f=>f.section.startsWith('controller_fan ')).map(f=>[f.section,readControllerFanPolicy(reader,f.section,plan.heaters.map(h=>h.section),plan.steppers.map(s=>s.section))]));
 const emitters=options.motion?compileConfiguredMotionEmitters(reader,plan,options.motion):undefined;
 if(Object.keys(ids).some(name=>!plan.heaters.some(h=>h.section===name)))throw new Error('Unknown heater G-code mapping');
 let readyHardware:object|undefined;
 const heaters=new AsyncPrinterHeaters(async signal=>{
  await options.beforeTarget?.(signal);signal.throwIfAborted();
  if(emitters){const barrier=readyHardware&&hardwareOwners.get(readyHardware)?.beforeTarget;if(!barrier)throw new Error('Configured motion target barrier is not ready');await barrier(signal);}
 }),analog:ReturnType<typeof attachConfiguredAnalogHeater>[]=[];
 const cleanup=new Set<(cause:unknown)=>Promise<void>>();
 const fans:{section:string;runtime:ScheduledCoolingFan}[]=[],abort=new AbortController();
 const buttons:{section:string;input:SwitchInput}[]=[];
 let motorEnable:MotorEnable|undefined,state:'starting'|'ready'|'stopping'|'stopped'|'failed'='starting',fault:unknown,stopError:unknown,closing:Promise<void>|undefined,detach=()=>{};
 const close=(cause:unknown=new Error('Configured hardware closed')):Promise<void>=>{
  if(closing)return closing;const done=Promise.withResolvers<void>();closing=done.promise;state='stopping';fault=cause;abort.abort(cause);detach();
  const jobs:Promise<void>[]=[];
  // Start independent safety immediately; never wait for a graceful output
  // transaction before initiating the MCU stop. Callbacks must not await us.
  for(const stop of [()=>group.stop(cause),()=>heaters.shutdown('Configured hardware stopped'),...analog.map(a=>()=>a.stop(cause)),...fans.map(f=>()=>f.runtime.stop(cause)),...Array.from(cleanup,stop=>()=>stop(cause))])try{jobs.push(Promise.resolve(stop()));}catch(error){jobs.push(Promise.reject(error));}
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
  for(const b of plan.buttons){b.timeline?.reserveClock(b.buttons.initialClock);const input=new SwitchInput(group.session(b.mcu),b.buttons,error=>{void close(error).catch(()=>{});});buttons.push({section:b.section,input});cleanup.add(cause=>input.close(cause));}
  // No generation reset or output activation until EVERY MCU finalized.
  for(const c of plan.configurations){await c.session.configure(c.plan,abort.signal);active();}
  for(const [i,b] of plan.buttons.entries()){buttons[i].input.activate(group.commandQueue(b.mcu));active();}
  if(plan.steppers.length)motorEnable=new MotorEnable(group,plan.motors.lines,plan.motors.alwaysOn);
  const output=(p:typeof plan.fans[number]['output'])=>{const s=group.session(p.mcu);return p.timeline?GenerationPWMOutput.withClock(p.pwm,s.dictionary,group.commandQueue(p.mcu),group.commandQueue(p.mcu),p.timeline):new GenerationPWMOutput(p.pwm,s.dictionary,group.commandQueue(p.mcu),group.commandQueue(p.mcu),p.clock.clockAt,p.clock.printTimeAtClock);};
  for(const f of plan.fans){const runtime=new ScheduledCoolingFan(output(f.output),f.config,f.enable?output(f.enable):undefined);fans.push({section:f.section,runtime});await runtime.start(abort.signal);active();}
  await heaters.start(abort.signal);active();for(const a of analog){a.sensor.activate();active();}
  for(const f of fans){const policy=thermalPolicies.get(f.section),controller=controllerPolicies.get(f.section);if(!policy&&!controller)continue;
   const p=plan.fans.find(p=>p.section===f.section)!;
   const now=()=>Math.max(...[p.output,...p.enable?[p.enable]:[]].map(o=>o.clock.printTimeAtClock(group.session(o.mcu).clock.sync.getClock(serialClock.now()))));
   const fault=(error:unknown)=>{void close(error).catch(()=>{});},activity=controller?new ControllerFanState(controller):undefined,selected=new Set(plan.steppers.filter(s=>controller?.steppers.includes(s.section)).map(s=>s.emitter));
   const owner=policy?new HeaterFanRuntime(f.runtime,policy,name=>heaters.getTemperature(name),now,fault):new PeriodicFanRuntime(f.runtime,()=>{
    const state=motorEnable?.status;
    const enabled=!!state&&(state.alwaysOn.some(s=>selected.has(s.emitter))||state.lines.some(l=>l.enabled&&l.emitters.some(id=>selected.has(id))));
    const heating=controller!.heaters.some(name=>heaters.getTemperature(name).target!==0);
    return activity!.speed(serialClock.now(),enabled||heating);
   },now,fault);
   cleanup.add(cause=>owner.stop(cause));owner.start();active();
  }
  state='ready';
  const result=Object.freeze({plan,emitters,heaters,analog:Object.freeze(analog),buttons:Object.freeze(buttons.map(b=>Object.freeze(b))),fans:Object.freeze(fans.map(f=>Object.freeze(f))),motorEnable,close,get status(){return {state,fault,stopError};}});
  hardwareOwners.set(result,{group,claimed:false,cleanup});readyHardware=result;return result;
 }catch(error){try{await close(error);}catch(cleanup){throw new AggregateError([error,cleanup],'Hardware startup and cleanup failed',{cause:error});}throw error;}
 finally{clearTimeout(timer);signal.removeEventListener('abort',cancelled);}
}
