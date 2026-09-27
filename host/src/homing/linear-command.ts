import {safeZHomingSettings,type SafeZHoming} from './safe-z-home.ts';
// Linear-axis G28 sequencing from klippy/extras/homing.py. GPL-3.0-or-later.
import {GCodeDispatch,GCodeError} from '../gcode/dispatch.ts';
import {GCodeMove,type MovePort} from '../gcode/move.ts';
import {LinearKinematics,type Axis} from '../kinematics/linear.ts';
import {homingSetPositionOffsets,type HomingHistoryBinding} from './position-offsets.ts';
import type {HomingStopSetResult} from './stop-set.ts';
import {observeRetirement} from '../motion/retired.ts';
export interface LinearHomingRail {
 readonly endstop:number;readonly positiveDirection:boolean;readonly speed:number;
 readonly retractDistance:number;readonly retractSpeed:number;readonly secondSpeed:number;
 /** Ordered exactly like the driver's independent stop groups. */
 readonly endstops:readonly string[];
}
export interface HomingPass {
 /** Motors commanded to move, excluding idle actuators retained for recovery. */
 readonly movingSteppers:readonly {readonly member:number;readonly oid:number}[];
 readonly stop:HomingStopSetResult;readonly histories:readonly HomingHistoryBinding[];
 readonly triggerClocks:readonly (readonly bigint[])[];
}
/** Privileged homing operations must not bypass admission for ordinary G-code.
 * home must execute armed drip motion and stop/recovery, publish the actual halt
 * position, and retain the old generation's history. retract waits for MCU-time
 * completion. forcePosition drains/rebuilds coordinate state without movement.
 * motorOff must fence pending work, including callbacks which settle late.
 * Every asynchronous operation must honor signal and check device health. */
export interface LinearHomingPort extends MovePort {
 readonly safeZHoming?:Readonly<SafeZHoming>;
 homingTravel?(position:readonly number[],speed:number,signal:AbortSignal):Promise<void>;
 /** Physical halt coordinates for privileged homing; ordinary position may be transformed. */
 homingPosition?():readonly number[];
 /** Complete final-pass coordinate correction before granting homing authority. */
 finishHoming?(pass:HomingPass,axis:Axis,endstop:number,signal:AbortSignal):Promise<void>;
 assertActive():void;
 drain(signal:AbortSignal):Promise<void>;
 forcePosition(position:readonly number[],signal:AbortSignal):Promise<void>;
 home(position:readonly number[],speed:number,axis:Axis,signal:AbortSignal):Promise<HomingPass>;
 retract(position:readonly number[],speed:number,axis:Axis,signal:AbortSignal):Promise<void>;
 motorOff(cause:unknown):Promise<void>;
}
export class HomingCommandError extends GCodeError {
 readonly code:'no_trigger'|'still_triggered';readonly endstop:string;
 constructor(code:'no_trigger'|'still_triggered',endstop:string){super(code==='no_trigger'?`No trigger on ${endstop} after full movement`:`Endstop ${endstop} still triggered after retract`);this.code=code;this.endstop=endstop;}
}
/** Exact original retract arithmetic. Null coordinates are already filled from
 * the current halt position, including every extra/extrusion axis. */
export function homingRetract(force:readonly number[],home:readonly number[],distance:number){
 if(force.length<4||force.length!==home.length||!force.every(Number.isFinite)||!home.every(Number.isFinite)||!Number.isFinite(distance)||distance<=0)throw new RangeError('Invalid homing retract');
 const delta=home.map((v,i)=>v-force[i]),length=Math.sqrt(delta.slice(0,3).reduce((sum,d)=>sum+d*d,0));
 if(!Number.isFinite(length)||length===0)throw new RangeError('Invalid homing retract length');
 const ratio=Math.min(1,distance/length),retract=home.map((v,i)=>v-delta[i]*ratio),start=retract.map((v,i)=>v-delta[i]*ratio);
 if(!retract.every(Number.isFinite)||!start.every(Number.isFinite)||retract.every((v,i)=>v===home[i])||start.every((v,i)=>v===retract[i]))throw new RangeError('Unrepresentable homing retract');
 return {retract,start};
}
/** Cartesian/CoreXY/CoreXZ only. The owning runtime must supply the concrete
 * native driver; registering this class alone does not wire printer hardware. */
export class LinearHomingCommand {
 #kin:LinearKinematics;#coordinates:GCodeMove;#port:LinearHomingPort;#rails:readonly LinearHomingRail[];#busy=false;#timeout:number;
 #safe:Readonly<SafeZHoming>|undefined;
 #cleanupPending=false;#cleanupFailed=false;#cleanupError:unknown;
 constructor(kinematics:LinearKinematics,coordinates:GCodeMove,port:LinearHomingPort,rails:readonly LinearHomingRail[],timeoutMs=120000){
  if(!coordinates.usesPort(port)||rails.length!==3||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>3600000)throw new Error('Invalid linear homing ownership');
  for(const [i,r] of rails.entries()){
   const geometry=kinematics.homingMove(i as Axis,r.endstop,r.positiveDirection);
   if(typeof r.positiveDirection!=='boolean'||![r.speed,r.retractSpeed,r.secondSpeed].every(v=>Number.isFinite(v)&&v>0)||!Number.isFinite(r.retractDistance)||r.retractDistance<0||geometry.force[i]===geometry.home[i]||!r.endstops.length||r.endstops.length>16||new Set(r.endstops).size!==r.endstops.length||r.endstops.some(n=>typeof n!=='string'||!n.length||n.length>128||/[\r\n\0]/.test(n)))throw new RangeError('Invalid linear homing rail');
  }
  if(port.safeZHoming){if(!port.homingTravel)throw new Error('Safe Z homing requires physical travel ownership');this.#safe=safeZHomingSettings(port.safeZHoming,kinematics.status);}
  this.#kin=kinematics;this.#coordinates=coordinates;this.#port=port;this.#rails=rails.map(r=>({...r,endstops:[...r.endstops]}));this.#timeout=timeoutMs;
 }
 get status(){return {busy:this.#busy,cleanupPending:this.#cleanupPending,cleanupFailed:this.#cleanupFailed,cleanupError:this.#cleanupError};}
 register(dispatch:GCodeDispatch):void{
  dispatch.register('G28',command=>{const axes=([0,1,2] as const).filter(i=>Object.hasOwn(command.params,'XYZ'[i]));return this.home(axes.length?axes:[0,1,2],command.signal);});
 }
 async home(axes:readonly Axis[],signal:AbortSignal):Promise<void>{
  if(this.#busy)throw new GCodeError('Homing is already active');
  if(this.#cleanupPending||this.#cleanupFailed)throw new GCodeError('Homing cleanup requires recovery');
  if(!axes.length||axes.some(a=>!Number.isInteger(a)||a<0||a>2)||new Set(axes).size!==axes.length)throw new RangeError('Invalid homing axes');
  signal.throwIfAborted();this.#busy=true;this.#cleanupError=undefined;
  const selected=[...axes].sort() as Axis[],deadline=new AbortController(),s=AbortSignal.any([signal,deadline.signal]);let cleanup:Promise<void>|undefined;
  const stop=(error:unknown)=>{
   if(cleanup)return cleanup;this.#kin.clearHoming([0,1,2]);this.#cleanupPending=true;
   cleanup=Promise.resolve().then(()=>this.#port.motorOff(error)).catch(e=>{this.#cleanupFailed=true;this.#cleanupError=e;throw e;}).finally(()=>{this.#cleanupPending=false;});void cleanup.catch(()=>{});return cleanup;
  };
  const abort=()=>{void stop(s.reason);};s.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>deadline.abort(new GCodeError('Homing timed out')),this.#timeout);
  const check=()=>{s.throwIfAborted();this.#port.assertActive();if(!this.#coordinates.usesPort(this.#port))throw new Error('Homing coordinate port changed');};
  const run=async<T>(work:Promise<T>):Promise<T>=>{let result!:T;await observeRetirement(work.then(value=>{result=value;}),s);check();return result;};
  const position=()=>{const p=[...(this.#port.homingPosition?.()??this.#port.position())];if(p.length<4||!p.every(Number.isFinite))throw new Error('Invalid homing toolhead position');return p;};
  const fill=(coord:readonly (number|null)[])=>{const p=position();for(let i=0;i<coord.length;i++)if(coord[i]!==null)p[i]=coord[i]!;return p;};
  const confirm=(pass:HomingPass,rail:LinearHomingRail,second:boolean)=>{
   if(pass.stop.groups.length!==rail.endstops.length)throw new Error('Homing endstop coverage mismatch');
   for(const [i,g] of pass.stop.groups.entries())if(g.hitClock===null)throw new HomingCommandError('no_trigger',rail.endstops[i]);
   const offsets=homingSetPositionOffsets(pass.stop,pass.histories,pass.triggerClocks);
   const moving=new Set(pass.movingSteppers.map(p=>`${p.member}:${p.oid}`));
   if(!moving.size||moving.size!==pass.movingSteppers.length||pass.movingSteppers.some(p=>!offsets.some(o=>o.member===p.member&&o.oid===p.oid)))throw new Error('Invalid moving homing steppers');
   if(second)for(const p of offsets)if(moving.has(`${p.member}:${p.oid}`)&&p.start===p.trigger){let group=pass.stop.memberOffsets.length-1;while(group>0&&pass.stop.memberOffsets[group]>p.member)group--;throw new HomingCommandError('still_triggered',rail.endstops[group]);}
  };
  try{
   check();await run(this.#port.drain(s));
   const safe=this.#safe,travel=async(target:number[],speed:number)=>{if(target.every((v,i)=>v===position()[i]))return;await run(this.#port.homingTravel!(target,speed,s));this.#coordinates.resetPosition();};
   if(safe?.hop){
    const p=position();if(!this.#kin.status.homedAxes.includes('z')){p[2]=0;await run(this.#port.forcePosition(p,s));p[2]=safe.hop;await run(this.#port.retract(p,safe.hopSpeed,2,s));this.#coordinates.resetPosition();}
    else if(p[2]<safe.hop){p[2]=safe.hop;await travel(p,safe.hopSpeed);}
   }
   this.#kin.clearHoming(selected);
   for(const axis of selected){
    check();let previousXY:readonly number[]|undefined;
    if(axis===2&&safe){if(!this.#kin.status.homedAxes.includes('x')||!this.#kin.status.homedAxes.includes('y'))throw new GCodeError('Safe Z homing requires homed XY');const p=position();previousXY=p.slice(0,2);p[0]=safe.position[0];p[1]=safe.position[1];await travel(p,safe.speed);}
    const rail=this.#rails[axis],geometry=this.#kin.homingMove(axis,rail.endstop,rail.positiveDirection),home=fill(geometry.home);
    await run(this.#port.forcePosition(fill(geometry.force),s));
    let finalPass=await run(this.#port.home(home,rail.speed,axis,s));confirm(finalPass,rail,false);
    if(rail.retractDistance){
     const target=fill(geometry.home),{retract,start}=homingRetract(fill(geometry.force),target,rail.retractDistance);
     await run(this.#port.retract(retract,rail.retractSpeed,axis,s));await run(this.#port.forcePosition(start,s));
     finalPass=await run(this.#port.home(target,rail.secondSpeed,axis,s));confirm(finalPass,rail,true);
    }
    await run(this.#port.drain(s));if(this.#port.finishHoming)await run(this.#port.finishHoming(finalPass,axis,rail.endstop,s));check();this.#coordinates.home([axis]);check();this.#kin.markHomed([axis]);
    if(axis===2&&safe){let p=position();if(safe.hop&&p[2]<safe.hop){p[2]=safe.hop;await travel(p,safe.hopSpeed);}if(safe.moveToPrevious){p=position();p[0]=previousXY![0];p[1]=previousXY![1];await travel(p,safe.speed);}}
   }
  }catch(error){
   const local=new AbortController(),timer=setTimeout(()=>local.abort(new Error('Homing motor-off cleanup timed out')),5000);
   try{await observeRetirement(stop(error),local.signal);if(this.#coordinates.usesPort(this.#port))this.#coordinates.resetPosition();}catch(stopError){throw new AggregateError([error,stopError],'Homing and motor-off failed');}
   finally{clearTimeout(timer);}throw error;
  }finally{clearTimeout(timer);s.removeEventListener('abort',abort);this.#busy=false;}
 }
}
