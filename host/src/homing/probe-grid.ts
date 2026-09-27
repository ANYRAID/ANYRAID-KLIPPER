import {BedMesh,type BedMeshParameters} from '../motion/bed-mesh.ts';
export interface ProbeGrid {mesh:BedMeshParameters;horizontalHeight:number;travelSpeed:number;}
/** Rectangular serpentine path in nozzle coordinates. Matrix indices stay in
 * ascending bed XY order, independently of traversal direction. */
export function planProbeGrid(options:ProbeGrid,offsets:readonly number[]){
 for(const count of [options.mesh.x_count,options.mesh.y_count])if(!Number.isInteger(count)||count<2||count>128)throw new RangeError('Invalid probe count');
 const mesh=new BedMesh(options.mesh,Array.from({length:options.mesh.y_count},()=>Array(options.mesh.x_count).fill(0)));
 const p=mesh.params;
 if(offsets.length!==3||!offsets.every(Number.isFinite)||!Number.isFinite(options.horizontalHeight)||!Number.isFinite(options.travelSpeed)||options.travelSpeed<=0)throw new RangeError('Invalid probe grid travel');
 const points=[];
 for(let y=0;y<p.y_count;y++)for(let i=0;i<p.x_count;i++){
  const x=y%2?p.x_count-1-i:i,bedX=p.min_x+(p.max_x-p.min_x)*x/(p.x_count-1),bedY=p.min_y+(p.max_y-p.min_y)*y/(p.y_count-1),nozzleX=bedX-offsets[0],nozzleY=bedY-offsets[1];
  if(![nozzleX,nozzleY].every(Number.isFinite))throw new RangeError('Probe grid coordinate overflow');
  points.push(Object.freeze({x,y,nozzleX,nozzleY}));
 }
 return Object.freeze({mesh:p,horizontalHeight:options.horizontalHeight,travelSpeed:options.travelSpeed,points:Object.freeze(points)});
}
export async function measureProbeGrid(plan:ReturnType<typeof planProbeGrid>,port:{position():readonly number[];move(target:readonly number[],speed:number):Promise<void>;probe():Promise<number>},signal:AbortSignal){
 const matrix=Array.from({length:plan.mesh.y_count},()=>Array<number>(plan.mesh.x_count));
 for(const point of plan.points){
  signal.throwIfAborted();const start=port.position(),raised=[...start];raised[2]=Math.max(start[2],plan.horizontalHeight);
  await port.move(raised,plan.travelSpeed);const xy=[...raised];xy[0]=point.nozzleX;xy[1]=point.nozzleY;await port.move(xy,plan.travelSpeed);
  // Never lower during XY travel; approach the configured probe height only
  // once the nozzle is over the next measurement point.
  xy[2]=plan.horizontalHeight;await port.move(xy,plan.travelSpeed);
  const z=await port.probe();if(!Number.isFinite(z))throw new Error('Invalid grid probe height');matrix[point.y][point.x]=z;
 }
 signal.throwIfAborted();const finish=[...port.position()];finish[2]=Math.max(finish[2],plan.horizontalHeight);await port.move(finish,plan.travelSpeed);signal.throwIfAborted();
 return new BedMesh(plan.mesh,matrix);
}
