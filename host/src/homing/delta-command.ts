import {ToolMovePort} from '../gcode/tool-move.ts';
// Simultaneous Delta G28 sequencing from klippy/extras/homing.py.
// GPL-3.0-or-later. A-tower timing controls the combined homing operation.
import {GCodeDispatch,GCodeError} from '../gcode/dispatch.ts';
import {GCodeMove} from '../gcode/move.ts';
import type {Axis} from '../kinematics/linear.ts';
import {DeltaKinematics} from '../kinematics/delta.ts';
import {observeRetirement} from '../motion/retired.ts';
import {confirmHomingPass,homingRetract,type HomingPass,type LinearHomingPort} from './linear-command.ts';
export interface DeltaHomingPort extends Pick<LinearHomingPort,'position'|'move'|'homingPosition'|'assertActive'|'drain'|'forcePosition'|'home'|'retract'|'motorOff'> {
 finishDeltaHoming?(pass:HomingPass,signal:AbortSignal):Promise<void>;
}
export interface DeltaHomingSettings {
 speed:number;secondSpeed:number;retractSpeed:number;retractDistance:number;
 /** All independent tower switches, in the native seek group order. */
 endstops:readonly string[];
}
/** This command requires a lifetime-owning native port; it alone does not
 * assemble hardware or enable the Delta product entrypoint. */
export class DeltaHomingCommand {
 #projection:ToolMovePort|undefined;
 #kin:DeltaKinematics;#coordinates:GCodeMove;#port:DeltaHomingPort;#settings:DeltaHomingSettings;#timeout:number;
 #busy=false;#cleanupPending=false;#cleanupFailed=false;#cleanupError:unknown;
 constructor(kin:DeltaKinematics,coordinates:GCodeMove,port:DeltaHomingPort,settings:DeltaHomingSettings,timeoutMs=120000,projection?:ToolMovePort){
  if(projection&&!projection.usesPort(port))throw new Error('Homing tool projection ownership differs');this.#projection=projection;
  if(!coordinates.usesPort(projection??port)||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>3600000||![settings.speed,settings.secondSpeed,settings.retractSpeed].every(v=>Number.isFinite(v)&&v>0)||!Number.isFinite(settings.retractDistance)||settings.retractDistance<0||settings.endstops.length<3||settings.endstops.length>16||new Set(settings.endstops).size!==settings.endstops.length||settings.endstops.some(n=>typeof n!=='string'||!n.length||n.length>128||/[\r\n\0]/.test(n)))throw new Error('Invalid Delta homing ownership or settings');
  this.#kin=kin;this.#coordinates=coordinates;this.#port=port;this.#settings={...settings,endstops:[...settings.endstops]};this.#timeout=timeoutMs;
 }
 get status(){return {busy:this.#busy,cleanupPending:this.#cleanupPending,cleanupFailed:this.#cleanupFailed,cleanupError:this.#cleanupError};}
 register(dispatch:GCodeDispatch){dispatch.register('G28',command=>this.home(command.signal));}
 /** Any G28 axis selection homes all three towers, matching Delta geometry. */
 home(signal:AbortSignal):Promise<void>;
 home(axes:readonly Axis[],signal:AbortSignal):Promise<void>;
 async home(axesOrSignal:readonly Axis[]|AbortSignal,suppliedSignal?:AbortSignal):Promise<void>{
  const signal=suppliedSignal??axesOrSignal as AbortSignal;
  if(suppliedSignal&&(!Array.isArray(axesOrSignal)||!axesOrSignal.length||new Set(axesOrSignal).size!==axesOrSignal.length||axesOrSignal.some(a=>!Number.isInteger(a)||a<0||a>2)))throw new RangeError('Invalid homing axes');
  if(this.#busy)throw new GCodeError('Homing is already active');
  if(this.#cleanupPending||this.#cleanupFailed)throw new GCodeError('Homing cleanup requires recovery');
  signal.throwIfAborted();this.#busy=true;this.#cleanupError=undefined;
  const deadline=new AbortController(),s=AbortSignal.any([signal,deadline.signal]);let cleanup:Promise<void>|undefined;
  const stop=(error:unknown)=>{
   if(cleanup)return cleanup;this.#kin.clearHoming();this.#cleanupPending=true;
   cleanup=Promise.resolve().then(()=>this.#port.motorOff(error)).catch(e=>{this.#cleanupFailed=true;this.#cleanupError=e;throw e;}).finally(()=>{this.#cleanupPending=false;});void cleanup.catch(()=>{});return cleanup;
  };
  const abort=()=>{void stop(s.reason);};s.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>deadline.abort(new GCodeError('Homing timed out')),this.#timeout);
  const check=()=>{s.throwIfAborted();this.#port.assertActive();if(!this.#coordinates.usesPort(this.#projection??this.#port))throw new Error('Homing coordinate port changed');};
  const run=async<T>(work:Promise<T>):Promise<T>=>{let result!:T;await observeRetirement(work.then(value=>{result=value;}),s);check();return result;};
  try{
   check();this.#kin.clearHoming();await run(this.#port.drain(s));
   const position=[...(this.#port.homingPosition?.()??this.#port.position())];
   if(position.length<4||!position.every(Number.isFinite))throw new Error('Invalid homing toolhead position');
   const geometry=this.#kin.homingMove(),force=[...geometry.force,...position.slice(3)],home=[...geometry.home,...position.slice(3)],r=this.#settings;
   // Validate retreat arithmetic before moving any motor.
   const retreat=r.retractDistance?homingRetract(force,home,r.retractDistance):undefined;
   await run(this.#port.forcePosition(force,s));
   let pass=await run(this.#port.home(home,r.speed,2,s));confirmHomingPass(pass,r.endstops,false);
   if(retreat){
    await run(this.#port.retract(retreat.retract,r.retractSpeed,2,s));await run(this.#port.forcePosition(retreat.start,s));
    pass=await run(this.#port.home(home,r.secondSpeed,2,s));confirmHomingPass(pass,r.endstops,true);
   }
   await run(this.#port.drain(s));if(this.#port.finishDeltaHoming)await run(this.#port.finishDeltaHoming(pass,s));
   check();this.#coordinates.home([0,1,2]);check();this.#kin.resetPosition('xyz');
  }catch(error){
   const local=new AbortController(),timer=setTimeout(()=>local.abort(new Error('Homing motor-off cleanup timed out')),5000);
   try{await observeRetirement(stop(error),local.signal);if(this.#coordinates.usesPort(this.#projection??this.#port))this.#coordinates.resetPosition();}
   catch(stopError){throw new AggregateError([error,stopError],'Homing and motor-off failed');}
   finally{clearTimeout(timer);}throw error;
  }finally{clearTimeout(timer);s.removeEventListener('abort',abort);this.#busy=false;}
 }
}
