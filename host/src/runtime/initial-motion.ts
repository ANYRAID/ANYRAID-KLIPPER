import {NativeDeltaHomingPort} from '../homing/native-delta-port.ts';
import {readDeltaMotionConfiguration} from '../config/delta-motion.ts';
import {readExtrusionConfiguration} from '../config/extrusion.ts';
import {compileDeltaHoming,type planDeltaHardware} from '../config/delta-printer.ts';
import {readServo} from '../config/servo.ts';
import {BoundaryOutputRouter} from '../outputs/boundary-router.ts';
import {OutputPinBoundaryTimeline} from '../outputs/output-pin-boundaries.ts';
import {configureEndstopPhases} from '../config/endstop-phase.ts';
import {readNativeBedMesh} from '../config/native-bed-mesh.ts';
import {compileLinearHoming,type ConfiguredLinearHoming} from '../config/linear-homing.ts';
import {readRetraction} from '../config/retraction.ts';
import {readArcResolution} from '../config/arcs.ts';
import {createNativeLinearPrint,type NativeLinearPrintOptions} from '../operations/native-linear-print.ts';
import {NativeLinearGCode} from './native-linear-gcode.ts';
import type {DispatchHooks} from '../gcode/dispatch.ts';
import {createConfiguredNativeLinearPort,type ConfiguredLinearHardware} from '../config/linear-motion.ts';
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {claimConfiguredMotion,type startConfiguredHardware} from './configured-hardware.ts';
import {MotionStopConfirmation} from '../motion/stop-confirmation.ts';
import {createStoppedMotion} from '../homing/rebuild-motion.ts';
import {bindRebuiltMotion} from './rebuilt-motion.ts';
import {FanBoundaryTimeline} from '../outputs/fan-boundaries.ts';
import {serialClock} from '../protocol/serial-queue.ts';
/** Machine policy and authorized file opening remain caller-owned. Lifecycle
 * stopOutputs must not await the containing hardware/print owner's close(). */
export interface ConfiguredPrintOptions extends Omit<NativeLinearPrintOptions,'gcode'|'port'|'heaters'|'mapping'> {output:DispatchHooks['output'];bedHeater?:string;homingTimeoutMs?:number;}
export interface InitialMotionOptions {
 /** Host coordinate origin only. Physical counters come from MCU readback. */
 position:readonly number[];
 routes:readonly {id:string;extrusionAxis?:number}[];
 fanSection?:string;
 leadTime?:number;
 timeoutMs?:number;
}
/** Single-use initialization of configured hardware. Stop all endstop sampling,
 * confirm physical stepper stop/readback, allocate native queues, ACK resets,
 * then bind transports. Never sets any homed-axis or extrusion permission. */
export async function initializeConfiguredMotion(hardware:Awaited<ReturnType<typeof startConfiguredHardware>>,options:InitialMotionOptions,signal:AbortSignal){
 signal.throwIfAborted();
 const {plan}=hardware,descriptors=hardware.emitters,position=Object.freeze([...options.position]),routes=options.routes.map(r=>Object.freeze({...r})),lead=options.leadTime??.2,timeout=options.timeoutMs??5000;
 if(!descriptors?.length||position.length<4||position.length>16||!position.every(Number.isFinite)||!routes.length||new Set(routes.map(r=>r.id)).size!==routes.length||!Number.isFinite(lead)||lead<.05||lead>2||!Number.isSafeInteger(timeout)||timeout<1||timeout>60000)throw new Error('Invalid initial motion configuration');
 const axes=routes.flatMap(r=>r.extrusionAxis===undefined?[]:[r.extrusionAxis]);
 if(routes.length!==position.length-2||routes.filter(r=>r.extrusionAxis===undefined).length!==1||new Set(axes).size!==position.length-3)throw new Error('Initial motion queue routing differs');
 for(const r of routes){const emitters=descriptors.filter(e=>e.queueId===r.id);if(!emitters.length||r.extrusionAxis!==undefined&&(!Number.isInteger(r.extrusionAxis)||r.extrusionAxis<3||r.extrusionAxis>=position.length)||emitters.some(e=>(e.mode==='extruder')!==(r.extrusionAxis!==undefined)))throw new Error('Initial motion queue routing differs');}
 if(descriptors.some(e=>!routes.some(r=>r.id===e.queueId)))throw new Error('Initial motion routes omit an emitter');
 const devices=plan.configurations.filter(c=>descriptors.some(e=>e.member===c.physicalMember)),triggers=devices.map(c=>{const t=plan.homing.flatMap(h=>h.triggers).find(t=>t.mcu===c.mcu);if(!t)throw new Error('Initial motion requires a configured stop trigger on every motor MCU');return t.protocol;});
 const fan=options.fanSection===undefined?undefined:hardware.fans.find(f=>f.section===options.fanSection),fanPlan=plan.fans.find(f=>f.section===options.fanSection);if(options.fanSection!==undefined&&(!fan||!fanPlan))throw new Error('Unknown initial motion fan');
 const auxiliaryMCUs=plan.configurations.filter(c=>!devices.includes(c)).map(c=>Object.freeze({id:c.mcu,calibration:Object.freeze({offset:c.clock.offset,frequency:c.clock.frequency})}));
 const emitters=Object.freeze(descriptors.map(e=>Object.freeze({...e,member:devices.findIndex(c=>c.physicalMember===e.member)}))),local=new AbortController();
 let printPending:ReturnType<typeof createNativeLinearPrint>|undefined;
 let port:ReturnType<typeof createConfiguredNativeLinearPort>['port']|undefined;
 let motion:ReturnType<typeof createStoppedMotion>|undefined,pending:ReturnType<typeof bindRebuiltMotion>|undefined;
 const group=claimConfiguredMotion(hardware,async cause=>{
  local.abort(cause);let generation:Awaited<ReturnType<typeof bindRebuiltMotion>>|undefined;
  if(pending)try{generation=await pending;}catch{/* failed binding owns its cleanup */}
  let print:Awaited<ReturnType<typeof createNativeLinearPrint>>|undefined;if(printPending)try{print=await printPending;}catch{/* print assembly owns its failed cleanup */}
  try{if(print)await print.close();else if(port)await port.dispose();else if(generation)await generation.coordinator.shutdown(cause);}finally{motion?.dispose();}
 },signal=>{if(!port)throw new Error('Configured linear motion target barrier is not ready');return port.heaterBoundary(signal);});
 const abort=()=>{local.abort(signal.reason);void hardware.close(signal.reason).catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(()=>{const error=new Error('Initial motion startup timed out');local.abort(error);void hardware.close(error).catch(()=>{});},timeout);
 const active=()=>{signal.throwIfAborted();local.signal.throwIfAborted();group.assertActive();};
 try{
  active();const members=devices.map((c,i)=>({session:c.session,queue:c.session.commandQueue(),trigger:triggers[i],steppers:emitters.filter(e=>e.member===i).map(e=>({oid:e.settings.oid,inverted:!!e.settings.invertDirection}))}));
  for(const h of plan.homing){await group.commandQueue(h.mcu).send(h.endstop.stop(),0n,0n,local.signal);active();}
  const stopped=await new MotionStopConfirmation(members,timeout).finish(local.signal);active();
  const now=serialClock.now(),printTime=Math.max(...plan.configurations.map(c=>c.clock.printTimeAtClock(c.session.clock.sync.getClock(now))))+lead;
  motion=createStoppedMotion(stopped,routes.map(r=>({id:r.id,position:(r.extrusionAxis===undefined?position.slice(0,3):[position[r.extrusionAxis],0,0]) as [number,number,number]})),emitters,printTime);
  for(const m of members)for(const s of m.steppers){await m.queue.send(m.session.dictionary.encode('reset_step_clock',{oid:s.oid,clock:0}),0n,0n,local.signal);active();}
  const timeline=fan?new FanBoundaryTimeline(fan.runtime):undefined;
  const pinRoutes=hardware.outputPins.map(p=>({name:p.settings.section,output:new OutputPinBoundaryTimeline(p.runtime)}));
  const routed=pinRoutes.length?new BoundaryOutputRouter([...timeline?[{name:'fan',output:timeline}]:[],...pinRoutes]):undefined;
  const outputMCUs=[...new Set([...plan.outputPins.map(p=>p.mcu),...fanPlan?[fanPlan.output.mcu,...fanPlan.enable?[fanPlan.enable.mcu]:[]]:[]])];
  pending=bindRebuiltMotion({group,clockTimelines:plan.configurations.map(c=>({id:c.mcu,timeline:c.timeline,synchronizer:c.synchronizer})),members,auxiliaryMCUs,motion,motorEnable:hardware.motorEnable,routes:routes.map(r=>({queue:motion!.queues.find(q=>q.id===r.id)!.queue,extrusionAxis:r.extrusionAxis})),position,...routed?{boundaryOutput:{output:routed,mcus:outputMCUs}}:timeline?{boundaryOutput:{output:timeline,mcus:outputMCUs}}:{}});
  const generation=await pending;active();
  // Only a pristine initial source may be transferred. The port becomes the
  // lifetime owner of every later rebase/homing generation, not just this one.
  const createLinearPort=(reader:ConfigurationReader,settings:Omit<ConfiguredLinearHardware,'generation'|'emitters'|'canExtrude'>|ConfiguredLinearHoming)=>{
   const arcResolution=readArcResolution(reader),retraction=readRetraction(reader),bedMesh=readNativeBedMesh(reader);
   group.assertActive();const state=generation.source.status;
   if(port||hardware.status.state!=='ready'||state.seeded||state.busy||state.retired||state.failed||state.bufferedMoves||state.pendingBoundaries)throw new Error('Initial motion already owned or used');
   const extruders=emitters.filter(e=>e.mode==='extruder'),section=extruders.length===1?plan.steppers.find(s=>s.emitter===extruders[0].id)?.section:undefined;
   const heater=hardware.thermal.find(h=>h.section===section)?.runtime;
   if(!heater)throw new Error('Linear motion requires its configured extruder heater');
   const resolved='homing' in settings?compileLinearHoming(plan,generation,settings,new Map(hardware.drivers.flatMap(d=>d.sensorless?[[d.section,d.sensorless] as const]:[]))):settings;
   const result=createConfiguredNativeLinearPort(reader,{...resolved,probeDevice:hardware.bltouch?{device:hardware.bltouch.device,endstop:hardware.bltouch.endstop}:undefined,endstopPhases:configureEndstopPhases(reader,plan.steppers,hardware.drivers),generation,emitters,canExtrude:()=>heater.canExtrude()});port=result.port;
   const createPrint=async(options:ConfiguredPrintOptions)=>{
    group.assertActive();if(printPending)throw new Error('Configured print already owned');
    const nozzle=section!.trim().split(/\s+/).at(-1)!,bed=options.bedHeater??'heater_bed';
    if(nozzle===bed||!hardware.heaters.status.available_heaters.some(name=>name.trim().split(/\s+/).at(-1)===bed))throw new Error('Configured print bed heater is missing');
    const gcode=new NativeLinearGCode(result.port,result.kinematics,result.rails,options.output,options.homingTimeoutMs,arcResolution,retraction,{stepper:extruders[0].id,name:section!},bedMesh,reader.hasSection('exclude_object'),reader.sections().filter(s=>s.startsWith('servo ')).map(s=>readServo(reader,s)));
    printPending=createNativeLinearPrint({...options,gcode,port:result.port,heaters:hardware.heaters,mapping:{nozzle,bed}});
    try{return await printPending;}catch(error){try{await hardware.close(error);}catch(cleanup){throw new AggregateError([error,cleanup],'Configured print and cleanup failed',{cause:error});}throw error;}
   };
   return Object.freeze({...result,createPrint});
  };
  const createDeltaPort=(reader:ConfigurationReader,settings:Pick<ReturnType<typeof planDeltaHardware>,'homing'|'kinematicIds'>)=>{
   group.assertActive();const state=generation.source.status;
   if(port||hardware.status.state!=='ready'||state.seeded||state.busy||state.retired||state.failed||state.bufferedMoves||state.pendingBoundaries)throw new Error('Initial motion already owned or used');
   if(reader.sections().some(n=>['probe','bltouch','safe_z_home'].includes(n)||n.startsWith('endstop_phase ')))throw new Error('Delta probe and phase adapters are not configured');
   const config=readDeltaMotionConfiguration(reader),geometry=config.kinematics.solverGeometry;
   if(settings.kinematicIds.length!==3||new Set(settings.kinematicIds).size!==3||settings.kinematicIds.some((id,i)=>{
    const mode=emitters.find(e=>e.id===id)?.mode,wanted=geometry[i];
    return typeof mode!=='object'||mode.kind!=='delta'||mode.armLength!==wanted.armLength||mode.towerX!==wanted.towerX||mode.towerY!==wanted.towerY;
   }))throw new Error('Configured Delta geometry differs from native solvers');
   const extruders=emitters.filter(e=>e.mode==='extruder'),section=extruders.length===1?plan.steppers.find(s=>s.emitter===extruders[0].id)?.section:undefined,heater=hardware.thermal.find(h=>h.section===section)?.runtime;
   if(!heater)throw new Error('Delta motion requires its configured extruder heater');
   const groups=compileDeltaHoming(plan,generation,settings.homing,new Map(hardware.drivers.flatMap(d=>d.sensorless?[[d.section,d.sensorless] as const]:[])));
   const extrusion=readExtrusionConfiguration(reader,config.limits.maxVelocity,config.limits.maxAccel);
   const owned=new NativeDeltaHomingPort({...config,extrusion,generation,emitters,kinematicIds:settings.kinematicIds,groups,canExtrude:()=>heater.canExtrude()});
   // Publish the lifetime owner before constructing any command adapters.
   port=owned;
   const homingSettings=Object.freeze({...config.rails[0].homing,endstops:Object.freeze(settings.homing.map(h=>h.section))});
   const createPrint=async(options:ConfiguredPrintOptions)=>{
    group.assertActive();if(printPending)throw new Error('Configured print already owned');
    const nozzle=section!.trim().split(/\s+/).at(-1)!,bed=options.bedHeater??'heater_bed';
    if(nozzle===bed||!hardware.heaters.status.available_heaters.some(name=>name.trim().split(/\s+/).at(-1)===bed))throw new Error('Configured print bed heater is missing');
    const gcode=new NativeLinearGCode(owned,config.kinematics,homingSettings,options.output,options.homingTimeoutMs,readArcResolution(reader),readRetraction(reader),{stepper:extruders[0].id,name:section!},readNativeBedMesh(reader),reader.hasSection('exclude_object'),reader.sections().filter(s=>s.startsWith('servo ')).map(s=>readServo(reader,s)));
    printPending=createNativeLinearPrint({...options,gcode,port:owned,heaters:hardware.heaters,mapping:{nozzle,bed}});
    try{return await printPending;}catch(error){try{await hardware.close(error);}catch(cleanup){throw new AggregateError([error,cleanup],'Configured Delta print and cleanup failed',{cause:error});}throw error;}
   };
   return Object.freeze({...config,port:owned,homingSettings,createPrint});
  };
  return Object.freeze({generation,emitters,stopped,createLinearPort,createDeltaPort,close:hardware.close});
 }catch(error){try{await hardware.close(error);}catch(cleanup){throw new AggregateError([error,cleanup],'Initial motion and cleanup failed',{cause:error});}throw error;}
 finally{clearTimeout(timer);signal.removeEventListener('abort',abort);}
}
