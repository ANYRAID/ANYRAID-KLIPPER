// GPL-3.0-or-later. Fade equations from extras/bed_mesh.py.
import type {BedMesh} from './bed-mesh.ts';
export interface BedMeshFadeConfig {start?:number;end?:number;target?:number|null;toolOffset?:number;}
export interface BedMeshFadeOptions {start:number;end:number;target:number;toolOffset?:number;}
/** Immutable numerical fade configuration, optionally resolved from a mesh. */
export class BedMeshFade {
 #automatic=false;
 get automaticTarget():boolean{return this.#automatic;}
 static forMesh(mesh:Pick<BedMesh,'average'|'range'>|null,config:BedMeshFadeConfig={}):BedMeshFade{
  const start=config.start??1,end=config.end??0;
  // Validate supplied numbers even when disabled or no mesh is selected.
  const preliminary=new BedMeshFade({start,end,target:config.target??0,toolOffset:config.toolOffset});
  const automatic=config.target===undefined||config.target===null;
  const target=mesh&&preliminary.enabled?(automatic?mesh.average():config.target!):0;
  const result=new BedMeshFade({start,end,target,toolOffset:config.toolOffset});result.#automatic=automatic;
  if(mesh)result.validateMesh(mesh);return result;
 }
 validateMesh(mesh:Pick<BedMesh,'average'|'range'>):void{
  if(!this.enabled)return;const [low,high]=mesh.range();
  if(this.distance<=Math.max(Math.abs(low),Math.abs(high))||this.distance<=high-this.target||(!this.#automatic&&this.target!==0&&(this.target<low||this.target>high)))throw new RangeError('Invalid mesh fade range or target');
  if(this.#automatic&&this.target!==mesh.average())throw new RangeError('Automatic fade target belongs to a different mesh');
 }
 readonly start:number;readonly end:number;readonly target:number;readonly toolOffset:number;readonly distance:number;readonly enabled:boolean;
 constructor(options:BedMeshFadeOptions){
  const {start,end,target,toolOffset=0}=options;
  if(![start,end,target,toolOffset].every(Number.isFinite))throw new RangeError('Invalid mesh fade parameters');
  const distance=end-start;if(!Number.isFinite(distance))throw new RangeError('Mesh fade distance overflow');
  this.enabled=distance>0;this.start=start;this.end=end;this.distance=distance;this.target=this.enabled?target:0;this.toolOffset=toolOffset;Object.freeze(this);
 }
 factor(z:number):number{
  const position=z+this.toolOffset;if(!Number.isFinite(z)||!Number.isFinite(position))throw new RangeError('Invalid fade position');
  if(!this.enabled)return 1;
  if(position>=this.end)return 0;
  if(position>=this.start)return (this.end-position)/this.distance;
  return 1;
 }
 apply(z:number,meshZ:number):number{
  if(!Number.isFinite(meshZ))throw new RangeError('Invalid mesh correction');
  const result=z+(this.factor(z)*(meshZ-this.target)+this.target);
  if(!Number.isFinite(result))throw new RangeError('Mesh fade correction overflow');return result;
 }
 /** Inverse of the piecewise linear fade. A nonpositive slope is ambiguous and
  * is rejected instead of producing a plausible but noninvertible position. */
 unapply(z:number,meshZ:number):number{
  if(!Number.isFinite(z)||!Number.isFinite(meshZ))throw new RangeError('Invalid mesh fade inverse');
  if(!this.enabled){const result=z-meshZ;if(!Number.isFinite(result))throw new RangeError('Mesh fade inverse overflow');return result;}
  const adjustment=meshZ-this.target,denominator=this.distance-adjustment,position=z+this.toolOffset;
  if(![adjustment,denominator,position,position-meshZ].every(Number.isFinite)||denominator<=0)throw new RangeError('Noninvertible mesh fade');
  let factor=1;
  if(Math.min(position,position-meshZ)>=this.end)factor=0;
  else if(Math.max(position,position-meshZ)>=this.start){const numerator=this.end+this.target-position;if(!Number.isFinite(numerator))throw new RangeError('Mesh fade inverse overflow');factor=Math.min(1,Math.max(0,numerator/denominator));}
  const result=z-(factor*adjustment+this.target);if(!Number.isFinite(result))throw new RangeError('Mesh fade inverse overflow');return result;
 }
}
