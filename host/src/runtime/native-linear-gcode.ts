import {bindServoCommands} from '../gcode/servo.ts';
import type {ServoSettings} from '../config/servo.ts';
import {bindOutputPinCommands} from '../gcode/output-pin.ts';
import type {NativeBedMeshConfiguration} from '../config/native-bed-mesh.ts';
import {GCodeDispatch,GCodeError,type DispatchHooks} from '../gcode/dispatch.ts';
import {GCodeMove} from '../gcode/move.ts';
import {ObjectCommands} from '../gcode/object-commands.ts';
import {FirmwareRetraction,type RetractionSettings} from '../gcode/retraction.ts';
import {DisplayStatus} from '../gcode/display-status.ts';
import {PrintLayerInfo} from '../gcode/print-layer-info.ts';
import {GCodeArcs} from '../gcode/arcs.ts';
import {bindVelocityCommands} from '../gcode/velocity-limits.ts';
import {bindPressureAdvanceCommand,type PressureAdvancePort} from '../gcode/pressure-advance.ts';
import {parseConfigurationFloat} from '../moonraker/config-reader.ts';
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
 readonly display=new DisplayStatus();
 readonly objects:ObjectCommands|undefined;
 readonly retraction:FirmwareRetraction|undefined;
 readonly pressureAdvance:PressureAdvancePort|undefined;
 readonly bedMeshStatus:(()=>Readonly<Record<string,import('../moonraker/rpc.ts').Json>>)|undefined;
 #port:NativeLinearHomingPort;#kinematics:LinearKinematics;#off:()=>void;#closed=false;
 #clockTimer:ReturnType<typeof setInterval>|undefined;#clockAbort=new AbortController();
 constructor(port:NativeLinearHomingPort,kinematics:LinearKinematics,rails:readonly LinearHomingRail[],output:DispatchHooks['output'],homingTimeoutMs=120000,arcResolution=1,retraction?:RetractionSettings,pressureBinding?:{stepper:string;name:string},bedMesh?:NativeBedMeshConfiguration,excludeObjects=false,servos:readonly ServoSettings[]=[]){
  if(pressureBinding){
   const {stepper,name}=pressureBinding;
   if(typeof name!=='string'||!name.trim()||name.length>256||name.includes('\0'))throw new Error('Invalid pressure advance object name');
   port.pressureAdvanceSettings(stepper);
   this.pressureAdvance=Object.freeze({name,get pressureAdvance(){return port.pressureAdvanceSettings(stepper);},applyPressureAdvance:(change,signal)=>port.setPressureAdvance(stepper,change.next,signal)} satisfies PressureAdvancePort);
  }
  const arcs=new GCodeArcs(arcResolution);
  this.retraction=retraction?new FirmwareRetraction(retraction):undefined;
  if(owners.has(port)||!port.usesKinematics(kinematics)||typeof output!=='function')throw new Error('Invalid native G-code ownership');
  port.assertActive();this.#port=port;this.#kinematics=kinematics;this.coordinates=new GCodeMove(port);
  this.homing=new LinearHomingCommand(kinematics,this.coordinates,port,rails,homingTimeoutMs);
  this.dispatch=new GCodeDispatch({output,unknownCommand:'shutdown',checkpoint:s=>port.flush(s),drain:s=>port.drain(s),shutdown:reason=>{void port.motorOff(new Error(reason)).catch(()=>{});}});
  for(const name of ['G0','G1','G20','G21','G90','G91','G92','M82','M83','M220','M221','SET_GCODE_OFFSET','SAVE_GCODE_STATE','RESTORE_GCODE_STATE'])this.dispatch.register(name,c=>{port.assertActive();this.coordinates.execute(name,c.params);});
  this.homing.register(this.dispatch);this.dispatch.register('M400',()=>{},{drainBefore:true});
  if(bedMesh){
   const settings=structuredClone(bedMesh.settings),profiles=bedMesh.profiles;let prior:object|undefined,cached:Readonly<Record<string,import('../moonraker/rpc.ts').Json>>;
   this.bedMeshStatus=()=>{const active=port.bedMeshStatus;if(prior!==active){cached=Object.freeze(Object.defineProperty(Object.defineProperties({},Object.getOwnPropertyDescriptors(active)),'profiles',{enumerable:true,get:()=>profiles.objectStatus}));prior=active;}return cached;};
   this.dispatch.register('BED_MESH_PROFILE',async c=>{if(Object.keys(c.params).some(k=>k!=='LOAD')||typeof c.params.LOAD!=='string'||!c.params.LOAD.trim())throw new GCodeError('Native saved mesh requires BED_MESH_PROFILE LOAD=name');const mesh=profiles.load(c.params.LOAD);await port.replaceBedMesh(mesh,settings,c.signal,c.params.LOAD);this.coordinates.resetPosition();},{drainBefore:true});
   this.dispatch.register('BED_MESH_CLEAR',async c=>{if(Object.keys(c.params).length)throw new GCodeError('BED_MESH_CLEAR takes no parameters');await port.replaceBedMesh(null,settings,c.signal);this.coordinates.resetPosition();},{drainBefore:true});
   this.dispatch.register('BED_MESH_OFFSET',async c=>{
    if(Object.keys(c.params).some(k=>!['X','Y','ZFADE'].includes(k)))throw new GCodeError('Invalid BED_MESH_OFFSET parameter');
    const values=['X','Y','ZFADE'].map(k=>{if(!Object.hasOwn(c.params,k))return null;try{return parseConfigurationFloat(c.params[k]);}catch{throw new GCodeError('Invalid BED_MESH_OFFSET '+k);}});
    if(await port.offsetBedMesh(values[0],values[1],values[2],c.signal))this.coordinates.resetPosition();else c.respondInfo('No mesh loaded to offset');
   },{drainBefore:true});
  }
  this.layers.register(this.dispatch);
  if(excludeObjects){this.objects=new ObjectCommands(this.coordinates,port);this.objects.register(this.dispatch);}
  this.display.register(this.dispatch);
  this.retraction?.register(this.dispatch,this.coordinates);
  bindVelocityCommands(this.dispatch,port);
  if(this.pressureAdvance)bindPressureAdvanceCommand(this.dispatch,this.pressureAdvance);
  arcs.register(this.dispatch,this.coordinates,s=>port.flush(s));
  this.dispatch.register('G4',c=>{let seconds=0;try{if(Object.hasOwn(c.params,'P'))seconds=parseConfigurationFloat(c.params.P)/1000;if(!Number.isFinite(seconds)||seconds<0||seconds>3600)throw new Error();}catch{throw new GCodeError('Invalid G4 P duration');}return port.dwell(seconds,c.signal);},{checkpoint:true});
  if(port.servoNames.length!==servos.length||servos.some(s=>!port.servoNames.includes(s.name)))throw new Error('Servo command bindings differ from hardware');
  if(servos.length)bindServoCommands(this.dispatch,servos,(name,value,signal)=>port.queueServoValue(name,value,signal));
  if(port.outputPinNames.length)bindOutputPinCommands(this.dispatch,port.outputPinNames,(name,value,signal)=>port.queueOutputPin(name,value,signal));
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
   this.#port.assertActive();this.objects?.reset();await prepare(s);s.throwIfAborted();this.#port.assertActive();
   if(mode==='home')await this.homing.home(axes,s);
   if(axes.some(a=>!this.#kinematics.status.homedAxes.includes('xyz'[a])))throw new Error('Print requires homed axes');
   s.throwIfAborted();this.enable();
  },signal);
 }
 usesPort(port:NativeLinearHomingPort):boolean{return this.#port===port;}
 async close():Promise<void>{this.#closed=true;this.#stopClockMaintenance();this.dispatch.emergencyStop('Native G-code closed');try{await this.#port.dispose();}finally{this.#off();}}
}
