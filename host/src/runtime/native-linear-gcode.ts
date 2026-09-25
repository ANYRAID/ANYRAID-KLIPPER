import {GCodeDispatch,GCodeError,type DispatchHooks} from '../gcode/dispatch.ts';
import {GCodeMove} from '../gcode/move.ts';
import {PrintLayerInfo} from '../gcode/print-layer-info.ts';
import {LinearHomingCommand,type LinearHomingRail} from '../homing/linear-command.ts';
import type {NativeLinearHomingPort} from '../homing/native-linear-port.ts';
import type {LinearKinematics,Axis} from '../kinematics/linear.ts';
import {bindCoolingFanCommands} from '../outputs/fan.ts';
const owners=new WeakSet<NativeLinearHomingPort>();
export interface PrintHomingPolicy {mode:'home'|'require_homed';axes:readonly Axis[];}
/** One native coordinate/dispatch owner. Heater, fan and machine-specific
 * handlers must be registered before enabling; unsupported commands stop.
 * Readiness permits G28, but never grants homing or bypasses thermal guards. */
export class NativeLinearGCode {
 readonly dispatch:GCodeDispatch;readonly coordinates:GCodeMove;readonly homing:LinearHomingCommand;
 readonly layers=new PrintLayerInfo();
 #port:NativeLinearHomingPort;#kinematics:LinearKinematics;#off:()=>void;#closed=false;
 #clockTimer:ReturnType<typeof setInterval>|undefined;#clockAbort=new AbortController();
 constructor(port:NativeLinearHomingPort,kinematics:LinearKinematics,rails:readonly LinearHomingRail[],output:DispatchHooks['output'],homingTimeoutMs=120000){
  if(owners.has(port)||!port.usesKinematics(kinematics)||typeof output!=='function')throw new Error('Invalid native G-code ownership');
  port.assertActive();this.#port=port;this.#kinematics=kinematics;this.coordinates=new GCodeMove(port);
  this.homing=new LinearHomingCommand(kinematics,this.coordinates,port,rails,homingTimeoutMs);
  this.dispatch=new GCodeDispatch({output,unknownCommand:'shutdown',checkpoint:s=>port.flush(s),drain:s=>port.drain(s),shutdown:reason=>{void port.motorOff(new Error(reason)).catch(()=>{});}});
  for(const name of ['G0','G1','G20','G21','G90','G91','G92','M82','M83','M220','M221','SET_GCODE_OFFSET','SAVE_GCODE_STATE','RESTORE_GCODE_STATE'])this.dispatch.register(name,c=>{port.assertActive();this.coordinates.execute(name,c.params);});
  this.homing.register(this.dispatch);this.dispatch.register('M400',c=>port.drain(c.signal));
  this.layers.register(this.dispatch);
  if(port.hasCoolingFan)bindCoolingFanCommands(this.dispatch,(value,signal)=>port.queueCoolingFan(value,signal));
  if(port.hasMotorEnable)for(const name of ['M18','M84'])this.dispatch.register(name,c=>{if(c.params.M!==name.slice(1)||Object.keys(c.params).some(key=>!['M','N','*'].includes(key)))throw new GCodeError('M18/M84 releases all motors; parameters are unsupported');if(!port.canReleaseMotors)throw new GCodeError('Always-on motors cannot be released by software');return port.releaseMotors(c.signal);});
  this.#off=port.subscribeStop(()=>{this.#closed=true;this.#stopClockMaintenance();this.dispatch.emergencyStop('Native motion stopped');});
  owners.add(port);
  this.#clockTimer=setInterval(()=>{
   if(this.#closed)return;
   void (async()=>{
    if(port.pausedClockMaintenanceDue)await port.maintainPausedClocks(this.#clockAbort.signal);
    else await this.dispatch.runWhenIdle(async s=>{if(port.idleClockMaintenanceDue)await port.maintainIdleClocks(s);},this.#clockAbort.signal);
   })().catch(error=>{if(!this.#closed)void port.motorOff(error).catch(()=>{});});
  },250);this.#clockTimer.unref();
 }
 #stopClockMaintenance(){clearInterval(this.#clockTimer);this.#clockTimer=undefined;this.#clockAbort.abort(new Error('Clock maintenance closed'));}
 enable():void{if(this.#closed)throw new Error('Native G-code closed');this.#port.assertActive();this.dispatch.setReady(true);}
 prepareForPrint(policy:PrintHomingPolicy,prepare:(signal:AbortSignal)=>Promise<void>,signal:AbortSignal):Promise<void>{
  const mode=policy.mode,axes=[...policy.axes];
  if(!['home','require_homed'].includes(mode)||!axes.length||axes.length>3||new Set(axes).size!==axes.length||axes.some(a=>!Number.isInteger(a)||a<0||a>2))return Promise.reject(new Error('Invalid print homing policy'));
  return this.dispatch.runExclusive(async s=>{
   this.#port.assertActive();await prepare(s);s.throwIfAborted();this.#port.assertActive();
   if(mode==='home')await this.homing.home(axes,s);
   if(axes.some(a=>!this.#kinematics.status.homedAxes.includes('xyz'[a])))throw new Error('Print requires homed axes');
   s.throwIfAborted();this.enable();
  },signal);
 }
 usesPort(port:NativeLinearHomingPort):boolean{return this.#port===port;}
 async close():Promise<void>{this.#closed=true;this.#stopClockMaintenance();this.dispatch.emergencyStop('Native G-code closed');try{await this.#port.dispose();}finally{this.#off();}}
}
