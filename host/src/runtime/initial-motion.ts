import {claimConfiguredMotion,type startConfiguredHardware} from './configured-hardware.ts';
import {MotionStopConfirmation} from '../motion/stop-confirmation.ts';
import {createStoppedMotion} from '../homing/rebuild-motion.ts';
import {bindRebuiltMotion} from './rebuilt-motion.ts';
import {FanBoundaryTimeline} from '../outputs/fan-boundaries.ts';
import {serialClock} from '../protocol/serial-queue.ts';
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
 let motion:ReturnType<typeof createStoppedMotion>|undefined,pending:ReturnType<typeof bindRebuiltMotion>|undefined;
 const group=claimConfiguredMotion(hardware,async cause=>{
  local.abort(cause);let generation:Awaited<ReturnType<typeof bindRebuiltMotion>>|undefined;
  if(pending)try{generation=await pending;}catch{/* failed binding owns its cleanup */}
  try{if(generation)await generation.coordinator.shutdown(cause);}finally{motion?.dispose();}
 });
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
  pending=bindRebuiltMotion({group,members,auxiliaryMCUs,motion,motorEnable:hardware.motorEnable,routes:routes.map(r=>({queue:motion!.queues.find(q=>q.id===r.id)!.queue,extrusionAxis:r.extrusionAxis})),position,...timeline?{boundaryOutput:{output:timeline,mcu:fanPlan!.output.mcu}}:{}});
  const generation=await pending;active();
  return Object.freeze({generation,emitters,stopped,close:hardware.close});
 }catch(error){try{await hardware.close(error);}catch(cleanup){throw new AggregateError([error,cleanup],'Initial motion and cleanup failed',{cause:error});}throw error;}
 finally{clearTimeout(timer);signal.removeEventListener('abort',abort);}
}
