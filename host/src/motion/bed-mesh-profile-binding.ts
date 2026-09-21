import {GCodeMove} from '../gcode/move.ts';
import {BedMeshMovePort} from './bed-mesh-port.ts';
import {BedMesh} from './bed-mesh.ts';
import type {BedMeshFadeConfig} from './bed-mesh-fade.ts';
import type {Move} from './lookahead.ts';
import type {BedMeshProfileRuntime} from './bed-mesh-profile-command.ts';
/** Command/runtime binding; the caller still supplies actual downstream drain.
 * Owns no hardware and does not silently retarget a different coordinate port. */
export class BedMeshProfileBinding implements BedMeshProfileRuntime {
 readonly #port:BedMeshMovePort;readonly #gcode:GCodeMove;readonly #fade:BedMeshFadeConfig;
 readonly #drain:(moves:Move[],signal:AbortSignal)=>Promise<void>;#busy=false;
 constructor(port:BedMeshMovePort,gcode:GCodeMove,fade:BedMeshFadeConfig,drain:(moves:Move[],signal:AbortSignal)=>Promise<void>){
  if(!gcode.usesPort(port)||typeof drain!=='function')throw new Error('Bed mesh binding requires its active coordinate port and drain');
  this.#port=port;this.#gcode=gcode;this.#fade={...fade};this.#drain=drain;
 }
 #check():void{if(this.#busy)throw new Error('Bed mesh profile transition active');if(!this.#gcode.usesPort(this.#port))throw new Error('Bed mesh coordinate port changed');}
 current():BedMesh|null{this.#check();return this.#port.currentMesh();}
 async activate(mesh:BedMesh,_name:string,signal:AbortSignal):Promise<void>{
  this.#check();signal.throwIfAborted();this.#busy=true;
  try{
   await this.#port.replaceMesh(mesh,this.#fade,this.#drain,signal);signal.throwIfAborted();
   if(!this.#gcode.usesPort(this.#port))throw new Error('Bed mesh coordinate port changed during drain');
   this.#gcode.resetPosition();
  }catch(error){this.#port.shutdown(error);throw this.#port.fault;}
  finally{this.#busy=false;}
 }
}
