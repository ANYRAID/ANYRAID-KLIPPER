// GPL-3.0-or-later. MoveSplitter port from extras/bed_mesh.py.
import type {BedMesh} from './bed-mesh.ts';
export type MeshMovePosition=[number,number,number,number];
export interface MeshSplitOptions {factor?:number;fadeOffset?:number;splitDeltaZ?:number;checkDistance?:number;}
/** Builds the entire transformed move before publishing any segments. The caller
 * must still atomically admit these segments to its motion queue. */
export function splitBedMeshMove(mesh:Pick<BedMesh,'calcZ'>,previous:readonly number[],next:readonly number[],options:MeshSplitOptions={}):MeshMovePosition[]{
 const factor=options.factor??1,fade=options.fadeOffset??0,threshold=options.splitDeltaZ??.025,step=options.checkDistance??5;
 if(!Array.isArray(previous)||!Array.isArray(next)||previous.length!==4||next.length!==4||!previous.every(Number.isFinite)||!next.every(Number.isFinite)||!Number.isFinite(factor)||factor<0||factor>1||!Number.isFinite(fade)||!Number.isFinite(threshold)||threshold<.01||!Number.isFinite(step)||step<3)throw new RangeError('Invalid mesh split input');
 const start=[...previous],end=[...next],delta=end.map((v,i)=>v-start[i]);if(!delta.every(Number.isFinite))throw new RangeError('Mesh move delta overflow');const length=Math.sqrt(delta[0]*delta[0]+delta[1]*delta[1]+delta[2]*delta[2]);if(!Number.isFinite(length))throw new RangeError('Mesh move distance overflow');const moving=delta.map(d=>Math.abs(d)>1e-10),checks=Math.ceil(length/step);if((moving[0]||moving[1])&&checks>100000)throw new RangeError('Mesh move check budget exceeded');
 const offset=(position:readonly number[])=>{const value=factor*(mesh.calcZ(position[0],position[1])-fade)+fade;if(!Number.isFinite(value))throw new RangeError('Mesh correction overflow');return value;};
 let zOffset=offset(start),distance=0;const current=[...start],result:MeshMovePosition[]=[];
 const emit=(position:readonly number[],z:number)=>{const corrected=position[2]+z;if(!Number.isFinite(corrected))throw new RangeError('Compensated Z overflow');result.push([position[0],position[1],corrected,position[3]]);};
 if(moving[0]||moving[1])while(distance+step<length){const advanced=distance+step;if(advanced<=distance)throw new RangeError('Mesh split distance below resolution');distance=advanced;const t=distance/length;if(t<0||t>1)throw new RangeError('Invalid mesh split fraction');for(let i=0;i<4;i++)if(moving[i])current[i]=(1-t)*start[i]+t*end[i];const z=offset(current);if(Math.abs(z-zOffset)>=threshold){zOffset=z;emit(current,z);}}
 emit(end,offset(end));return result;
}
