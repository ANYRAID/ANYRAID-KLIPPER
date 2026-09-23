import {GCodeDispatch,type DispatchHooks} from '../gcode/dispatch.ts';
import {GCodeMove} from '../gcode/move.ts';
import {LinearHomingCommand,type LinearHomingRail} from '../homing/linear-command.ts';
import type {NativeLinearHomingPort} from '../homing/native-linear-port.ts';
import type {LinearKinematics} from '../kinematics/linear.ts';
const owners=new WeakSet<NativeLinearHomingPort>();
/** One native coordinate/dispatch owner. Heater, fan and machine-specific
 * handlers must be registered before enabling; unsupported commands stop.
 * Readiness permits G28, but never grants homing or bypasses thermal guards. */
export class NativeLinearGCode {
 readonly dispatch:GCodeDispatch;readonly coordinates:GCodeMove;readonly homing:LinearHomingCommand;
 #port:NativeLinearHomingPort;#off:()=>void;#closed=false;
 constructor(port:NativeLinearHomingPort,kinematics:LinearKinematics,rails:readonly LinearHomingRail[],output:DispatchHooks['output'],homingTimeoutMs=120000){
  if(owners.has(port)||!port.usesKinematics(kinematics)||typeof output!=='function')throw new Error('Invalid native G-code ownership');
  port.assertActive();this.#port=port;this.coordinates=new GCodeMove(port);
  this.homing=new LinearHomingCommand(kinematics,this.coordinates,port,rails,homingTimeoutMs);
  this.dispatch=new GCodeDispatch({output,unknownCommand:'shutdown',checkpoint:s=>port.flush(s),drain:s=>port.drain(s),shutdown:reason=>{void port.motorOff(new Error(reason)).catch(()=>{});}});
  for(const name of ['G0','G1','G20','G21','G90','G91','G92','M82','M83','M220','M221','SET_GCODE_OFFSET','SAVE_GCODE_STATE','RESTORE_GCODE_STATE'])this.dispatch.register(name,c=>{port.assertActive();this.coordinates.execute(name,c.params);});
  this.homing.register(this.dispatch);this.dispatch.register('M400',c=>port.drain(c.signal));
  this.#off=port.subscribeStop(()=>{this.#closed=true;this.dispatch.emergencyStop('Native motion stopped');});
  owners.add(port);
 }
 enable():void{if(this.#closed)throw new Error('Native G-code closed');this.#port.assertActive();this.dispatch.setReady(true);}
 async close():Promise<void>{this.#closed=true;this.dispatch.emergencyStop('Native G-code closed');try{await this.#port.dispose();}finally{this.#off();}}
}
