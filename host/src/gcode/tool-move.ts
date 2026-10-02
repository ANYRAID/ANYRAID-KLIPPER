import {MultiExtrusionObjectExclusion} from './multi-extrusion-exclusion.ts';
import {GCodeMove,type MovePort} from './move.ts';
/** Projects exactly one physical filament axis onto G-code E. Inactive filament
 * positions come from the native owner, never from an old G-code snapshot. */
export class ToolMovePort implements MovePort {
 readonly #port:MovePort;readonly #count:number;readonly #drain:(signal:AbortSignal)=>Promise<void>;
 #exclusion:MultiExtrusionObjectExclusion|undefined;
 #active=0;#busy=false;
 constructor(port:MovePort,count:number,drain:(signal:AbortSignal)=>Promise<void>){
  if(!Number.isInteger(count)||count<1||count>13||typeof drain!=='function')throw new RangeError('Invalid tool routing');
  this.#port=port;this.#count=count;this.#drain=drain;this.#physical();
 }
 get hasObjectExclusion(){return this.#exclusion!==undefined;}
 installObjectExclusion():MultiExtrusionObjectExclusion{if(this.#busy||this.#exclusion)throw new Error('Tool transform already owned');const filter=new MultiExtrusionObjectExclusion(this.#port);this.#exclusion=filter;return filter;}
 removeObjectExclusion(filter:MultiExtrusionObjectExclusion):void{if(this.#busy||this.#exclusion!==filter)throw new Error('Tool transform ownership changed');this.#exclusion=undefined;}
 usesPort(port:MovePort):boolean{return this.#port===port;}
 get active(){return this.#active;}
 #physical(){const p=[...(this.#exclusion??this.#port).position()];if(p.length!==this.#count+3||!p.every(Number.isFinite))throw new Error('Tool coordinate ownership differs');return p;}
 position():readonly number[]{const p=this.#physical();return [p[0],p[1],p[2],p[3+this.#active]];}
 move(position:readonly number[],speed:number){
  if(this.#busy)throw new Error('Tool selection owns motion');
  if(position.length!==4||!position.every(Number.isFinite))throw new RangeError('Tool move requires XYZE');
  const p=this.#physical();for(let i=0;i<3;i++)p[i]=position[i];p[3+this.#active]=position[3];
  return this.#exclusion?this.#exclusion.move(p,speed,3+this.#active):this.#port.move(p,speed);
 }
 async select(index:number,coordinates:GCodeMove,signal:AbortSignal):Promise<void>{
  signal.throwIfAborted();
  if(!Number.isInteger(index)||index<0||index>=this.#count)throw new RangeError('Unknown tool');
  if(this.#busy||!coordinates.usesPort(this))throw new Error('Tool selection requires exclusive coordinate ownership');
  if(index===this.#active)return;
  this.#busy=true;
  try{await this.#drain(signal);signal.throwIfAborted();this.#physical();this.#active=index;coordinates.activateExtruder();}
  finally{this.#busy=false;}
 }
}
