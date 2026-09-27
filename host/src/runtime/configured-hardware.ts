import {attachConfiguredSpiHeater} from '../config/spi-heater.ts';
import {startMax31856} from '../thermal/max31856-startup.ts';
import type {AsyncHeaterRuntime} from '../thermal/async-runtime.ts';
import {attachConfiguredSpiSensor} from '../config/spi-temperature.ts';
import {HostTemperature} from '../thermal/host-temperature.ts';
import {attachConfiguredAnalogSensor} from '../config/analog-sensor.ts';
import {attachConfiguredBLTouch} from './bltouch.ts';
import {Tmc2240Current} from '../drivers/tmc2240-current.ts';
import {TmcPhaseState} from '../drivers/tmc-phase.ts';
import {registerStoppedPositionObserver} from '../motion/stopped-position-observer.ts';
import {TmcSensorlessMode} from '../drivers/tmc-sensorless.ts';
import {Tmc5160Current} from '../drivers/tmc5160-current.ts';
import type {TmcCurrentControl} from '../drivers/tmc-current.ts';
import {sessionTmcSpi} from '../drivers/tmc-spi-mcu.ts';
import {Tmc220xCurrent} from '../drivers/tmc220x-current.ts';
import {Tmc220xMonitor} from '../drivers/tmc220x-monitor.ts';
import {sessionTmcUart} from '../drivers/tmc-uart-mcu.ts';
import {initializeTmc220x} from '../drivers/tmc220x.ts';
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
 const thermalPolicies=new Map(plan.fans.filter(f=>f.section.startsWith('heater_fan ')).map(f=>[f.section,readHeaterFanPolicy(reader,f.section,plan.allHeaters.map(h=>h.section))]));
 const controllerPolicies=new Map(plan.fans.filter(f=>f.section.startsWith('controller_fan ')).map(f=>[f.section,readControllerFanPolicy(reader,f.section,plan.allHeaters.map(h=>h.section),plan.steppers.map(s=>s.section))]));
 const emitters=options.motion?compileConfiguredMotionEmitters(reader,plan,options.motion):undefined;
 if(Object.keys(ids).some(name=>!plan.allHeaters.some(h=>h.section===name)))throw new Error('Unknown heater G-code mapping');
 let readyHardware:object|undefined;let bltouch:ReturnType<typeof attachConfiguredBLTouch>|undefined;
 const heaters=new AsyncPrinterHeaters(async signal=>{
  await options.beforeTarget?.(signal);signal.throwIfAborted();
  if(emitters){const barrier=readyHardware&&hardwareOwners.get(readyHardware)?.beforeTarget;if(!barrier)throw new Error('Configured motion target barrier is not ready');await barrier(signal);}
 }),analog:ReturnType<typeof attachConfiguredAnalogHeater>[]=[];
 const spiHeaters:ReturnType<typeof attachConfiguredSpiHeater>[]=[],thermal:{section:string;runtime:AsyncHeaterRuntime}[]=[];
 const hostSensors:HostTemperature[]=[];
 const sensors:(ReturnType<typeof attachConfiguredAnalogSensor>|ReturnType<typeof attachConfiguredSpiSensor>)[]=[];
 const cleanup=new Set<(cause:unknown)=>Promise<void>>();
 const fans:{section:string;runtime:ScheduledCoolingFan}[]=[],abort=new AbortController();
 const buttons:{section:string;input:SwitchInput}[]=[];
 const drivers:{section:string;monitor:Tmc220xMonitor;current:TmcCurrentControl;phase:TmcPhaseState;sensorless?:TmcSensorlessMode}[]=[];
 let motorEnable:MotorEnable|undefined,state:'starting'|'ready'|'stopping'|'stopped'|'failed'='starting',fault:unknown,stopError:unknown,closing:Promise<void>|undefined,detach=()=>{};
 const close=(cause:unknown=new Error('Configured hardware closed')):Promise<void>=>{
  if(closing)return closing;const done=Promise.withResolvers<void>();closing=done.promise;state='stopping';fault=cause;abort.abort(cause);detach();
  const jobs:Promise<void>[]=[];
  // Start independent safety immediately; never wait for a graceful output
  // transaction before initiating the MCU stop. Callbacks must not await us.
  for(const stop of [()=>group.stop(cause),()=>heaters.shutdown('Configured hardware stopped'),...analog.map(a=>()=>a.stop(cause)),...spiHeaters.map(a=>()=>a.stop(cause)),...sensors.map(s=>()=>s.sensor.stop(cause)),...hostSensors.map(s=>()=>s.close(cause)),...fans.map(f=>()=>f.runtime.stop(cause)),...Array.from(cleanup,stop=>()=>stop(cause))])try{jobs.push(Promise.resolve(stop()));}catch(error){jobs.push(Promise.reject(error));}
  void Promise.allSettled(jobs).then(results=>{const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length){state='failed';stopError=new AggregateError(errors,'Configured hardware stop failed',{cause});done.reject(stopError);}else{state='stopped';done.resolve();}});
  return closing;
 };
 owners.add(group);
 const cancelled=()=>{void close(signal.reason).catch(()=>{});};signal.addEventListener('abort',cancelled,{once:true});
 const timer=setTimeout(()=>{void close(new Error('Hardware startup timed out')).catch(()=>{});},timeout);
 const active=()=>{signal.throwIfAborted();abort.signal.throwIfAborted();group.assertActive();};
 try{
  detach=group.subscribeStop(cause=>{void close(cause).catch(()=>{});});active();
  for(const h of plan.allHeaters){const a=plan.heaters.find(p=>p.section===h.section);let binding:ReturnType<typeof attachConfiguredAnalogHeater>|ReturnType<typeof attachConfiguredSpiHeater>;
   if(a){binding=attachConfiguredAnalogHeater(group,a);analog.push(binding);}else{binding=attachConfiguredSpiHeater(group,plan.spiHeaters.find(p=>p.section===h.section)!);spiHeaters.push(binding);}
   thermal.push({section:h.section,runtime:binding.runtime});heaters.register(h.section,binding.runtime,ids[h.section]);
  }
  for(const p of plan.hostSensors){const sensor=await HostTemperature.open(p,error=>{void close(error).catch(()=>{});},abort.signal);hostSensors.push(sensor);if(abort.signal.aborted)await sensor.close(abort.signal.reason);active();heaters.registerSensor(p.section,sensor.state,p.gcodeId);}
  for(const p of plan.sensors){const binding=attachConfiguredAnalogSensor(group,p);sensors.push(binding);heaters.registerSensor(p.section,binding.state,p.gcodeId);}
  for(const p of plan.spiSensors){const binding=attachConfiguredSpiSensor(group,p);sensors.push(binding);heaters.registerSensor(p.section,binding.state,p.gcodeId);}
  for(const b of plan.buttons){b.timeline?.reserveClock(b.buttons.initialClock);const input=new SwitchInput(group.session(b.mcu),b.buttons,error=>{void close(error).catch(()=>{});});buttons.push({section:b.section,input});cleanup.add(cause=>input.close(cause));}
  // No generation reset or output activation until EVERY MCU finalized.
  for(const c of plan.configurations){await c.session.configure(c.plan,abort.signal);active();}
  await Promise.all([...plan.spiSensors,...plan.spiHeaters.map(h=>h.sensor)].filter(p=>p.model==='MAX31856').map(p=>startMax31856(group.session(p.mcu),p,abort.signal)));active();
  // All enable GPIOs are configured/restarted off. No motion/output owner is
  // exposed until every driver has acknowledged its complete register plan.
  const phaseOwner=(device:{read(register:number,signal:AbortSignal):Promise<number>},driver:{stepper:string;microsteps:number})=>{
   const stepper=plan.steppers.find(s=>s.section===driver.stepper);if(!stepper)throw new Error('TMC phase stepper missing');
   const phase=new TmcPhaseState(driver.microsteps,!!stepper.direction.invert),session=group.session(stepper.mcu);
   const detach=registerStoppedPositionObserver(session,stepper.compressor.oid,async(position,signal)=>{const s=AbortSignal.any([signal,abort.signal]);
    try{s.throwIfAborted();const word=await device.read(0x6a,s);s.throwIfAborted();phase.synchronize(word&1023,position);}
    catch(error){phase.invalidate();void close(error).catch(()=>{});throw error;}
   });cleanup.add(async()=>{detach();phase.retire();});return phase;
  };
  const sensorless=(device:ConstructorParameters<typeof TmcSensorlessMode>[0],driver:{model:string;stepper:string;registers:ConstructorParameters<typeof TmcSensorlessMode>[2]})=>{const sections=plan.homing.filter(h=>h.sensorless?.section===driver.model+' '+driver.stepper);if(!sections.length)return undefined;const diag=sections[0].sensorless!.diag;if(sections.some(h=>h.sensorless!.diag!==diag))throw new Error('Conflicting sensorless DIAG owners');return new TmcSensorlessMode(device,driver.model,driver.registers,diag,abort.signal,error=>{void close(error).catch(()=>{});});};
  for(const uart of plan.tmcUarts){const bus=sessionTmcUart(group.session(uart.mcu));for(const driver of uart.devices){const device=bus.register(uart.uart.oid,driver.address);await initializeTmc220x(device,driver,abort.signal);active();const fault=(error:unknown)=>{void close(error).catch(()=>{});},current=driver.model==='tmc2240'?new Tmc2240Current(device,driver,abort.signal,fault):new Tmc220xCurrent(device,driver,abort.signal,fault),monitor=new Tmc220xMonitor(device,fault,undefined,driver.model==='tmc2240'?{model:'tmc2240',currentActive:()=>false}:undefined);drivers.push({section:driver.model+' '+driver.stepper,monitor,phase:phaseOwner(device,driver),sensorless:sensorless(device,driver),current});cleanup.add(cause=>monitor.stop(cause));await monitor.start(abort.signal);active();}}
  for(const bus of plan.tmcSpis){const chain=sessionTmcSpi(group.session(bus.mcu),bus.spi.oid,bus.length);for(const entry of bus.devices){
   const driver=entry.plan,device=chain.register(entry.position);await initializeTmc220x(device,driver,abort.signal);active();
   const fault=(error:unknown)=>{void close(error).catch(()=>{});},current=driver.model==='tmc2240'?new Tmc2240Current(device,driver,abort.signal,fault):driver.model==='tmc5160'?new Tmc5160Current(device,driver,abort.signal,fault):new Tmc220xCurrent(device,driver,abort.signal,fault),emitter=plan.steppers.find(s=>s.section===driver.stepper)!.emitter;
   const monitor=new Tmc220xMonitor(device,fault,undefined,{model:driver.model,currentActive:()=>current.current.irun>=4&&current.current.ihold>0&&!!motorEnable?.status.lines.some(l=>l.enabled&&l.emitters.some(id=>id===emitter))});
   drivers.push({section:driver.model+' '+driver.stepper,monitor,current,phase:phaseOwner(device,driver),sensorless:sensorless(device,driver)});cleanup.add(cause=>monitor.stop(cause));await monitor.start(abort.signal);active();
  }}
  for(const [i,b] of plan.buttons.entries()){buttons[i].input.activate(group.commandQueue(b.mcu));active();}
  if(plan.steppers.length)motorEnable=new MotorEnable(group,plan.motors.lines,plan.motors.alwaysOn);
  const output=(p:typeof plan.fans[number]['output'])=>{const s=group.session(p.mcu);return p.timeline?GenerationPWMOutput.withClock(p.pwm,s.dictionary,group.commandQueue(p.mcu),group.commandQueue(p.mcu),p.timeline):new GenerationPWMOutput(p.pwm,s.dictionary,group.commandQueue(p.mcu),group.commandQueue(p.mcu),p.clock.clockAt,p.clock.printTimeAtClock);};
  for(const f of plan.fans){const runtime=new ScheduledCoolingFan(output(f.output),f.config,f.enable?output(f.enable):undefined);fans.push({section:f.section,runtime});await runtime.start(abort.signal);active();}
  if(plan.bltouch){bltouch=attachConfiguredBLTouch(group,plan);cleanup.add(cause=>bltouch!.close(cause));await bltouch.start(abort.signal);active();}
  await heaters.start(abort.signal);active();for(const a of [...analog,...spiHeaters]){a.sensor.activate();active();}
  for(const s of sensors){s.sensor.activate();active();}
  for(const s of hostSensors){await s.start(abort.signal);active();}
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
  const result=Object.freeze({plan,emitters,heaters,bltouch,drivers:Object.freeze(drivers.map(d=>Object.freeze(d))),analog:Object.freeze(analog),spiHeaters:Object.freeze(spiHeaters),thermal:Object.freeze(thermal.map(h=>Object.freeze(h))),sensors:Object.freeze(sensors),hostSensors:Object.freeze(hostSensors),buttons:Object.freeze(buttons.map(b=>Object.freeze(b))),fans:Object.freeze(fans.map(f=>Object.freeze(f))),motorEnable,close,get status(){return {state,fault,stopError};}});
  hardwareOwners.set(result,{group,claimed:false,cleanup});readyHardware=result;return result;
 }catch(error){try{await close(error);}catch(cleanup){throw new AggregateError([error,cleanup],'Hardware startup and cleanup failed',{cause:error});}throw error;}
 finally{clearTimeout(timer);signal.removeEventListener('abort',cancelled);}
}
