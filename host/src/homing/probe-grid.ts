import {BedMesh,type BedMeshParameters} from '../motion/bed-mesh.ts';
export interface FaultyProbeRegion {min:readonly [number,number];max:readonly [number,number];}
export interface ProbeGrid {faultyRegions?:readonly FaultyProbeRegion[];mesh:BedMeshParameters;horizontalHeight:number;travelSpeed:number;zeroReference?:readonly [number,number];circle?:{radius:number;origin:readonly [number,number]};}
/** Rectangular or circular serpentine path in nozzle coordinates. Matrix indices stay in
 * ascending bed XY order, independently of traversal direction. */
export function planProbeGrid(options:ProbeGrid,offsets:readonly number[]){
 for(const count of [options.mesh.x_count,options.mesh.y_count])if(!Number.isInteger(count)||count<2||count>128)throw new RangeError('Invalid probe count');
 let parameters={...options.mesh};const circle=options.circle;let circleStepHundredths=0;
 if(circle){
  const {radius,origin}=circle,n=parameters.x_count;
  if(!Number.isFinite(radius)||radius<=0||origin.length!==2||!origin.every(Number.isFinite)||n!==parameters.y_count||n%2!==1)throw new RangeError('Invalid circular probe grid');
  const step=Math.floor(2*radius/(n-1)*100)/100;if(step<1)throw new RangeError('Circular probe spacing must be at least 1mm');
  // Keep the rounded grid in integer hundredths so 3 * 1.3 cannot drop a boundary row.
  circleStepHundredths=Math.floor(2*radius/(n-1)*100);const extent=Math.floor(n/2)*circleStepHundredths/100;parameters={...parameters,min_x:origin[0]-extent,max_x:origin[0]+extent,min_y:origin[1]-extent,max_y:origin[1]+extent};
 }
 const mesh=new BedMesh(parameters,Array.from({length:options.mesh.y_count},()=>Array(options.mesh.x_count).fill(0)));
 const p=mesh.params;
 if(offsets.length!==3||!offsets.every(Number.isFinite)||!Number.isFinite(options.horizontalHeight)||!Number.isFinite(options.travelSpeed)||options.travelSpeed<=0)throw new RangeError('Invalid probe grid travel');
 const reference=options.zeroReference?Object.freeze([...options.zeroReference] as [number,number]):undefined;
 if(reference&&(reference.length!==2||!reference.every(Number.isFinite)))throw new RangeError('Invalid zero reference');
 const external=!!reference&&(reference[0]<p.min_x||reference[0]>p.max_x||reference[1]<p.min_y||reference[1]>p.max_y);
 const regions=(options.faultyRegions??[]).map(r=>{
  if(r.min.length!==2||r.max.length!==2||![...r.min,...r.max].every(Number.isFinite))throw new RangeError('Invalid faulty region');
  return {min:[Math.min(r.min[0],r.max[0]),Math.min(r.min[1],r.max[1])],max:[Math.max(r.min[0],r.max[0]),Math.max(r.min[1],r.max[1])]};
 });
 if(regions.length>99)throw new RangeError('Too many faulty regions');
 const within=(x:number,y:number,r:{min:readonly number[];max:readonly number[]},tol=0)=>x>=r.min[0]-tol&&x<=r.max[0]+tol&&y>=r.min[1]-tol&&y<=r.max[1]+tol;
 for(let i=0;i<regions.length;i++)for(let j=0;j<i;j++){const a=regions[i],b=regions[j];if(a.min[0]<=b.max[0]&&a.max[0]>=b.min[0]&&a.min[1]<=b.max[1]&&a.max[1]>=b.min[1])throw new RangeError('Overlapping faulty regions');}
 if(external&&regions.some(r=>within(reference![0],reference![1],r)))throw new RangeError('Zero reference lies within faulty region');
 const points=[];
 for(let y=0;y<p.y_count;y++)for(let i=0;i<p.x_count;i++){
  const x=y%2?p.x_count-1-i:i,bedX=circle?circle.origin[0]+(x-(p.x_count-1)/2)*circleStepHundredths/100:p.min_x+(p.max_x-p.min_x)*x/(p.x_count-1),bedY=circle?circle.origin[1]+(y-(p.y_count-1)/2)*circleStepHundredths/100:p.min_y+(p.max_y-p.min_y)*y/(p.y_count-1),nozzleX=bedX-offsets[0],nozzleY=bedY-offsets[1];
  if(circle){const dx=(x-(p.x_count-1)/2)*circleStepHundredths/100,dy=(y-(p.y_count-1)/2)*circleStepHundredths/100;if(Math.sqrt(dx*dx+dy*dy)>circle.radius)continue;}
  if(![nozzleX,nozzleY].every(Number.isFinite))throw new RangeError('Probe grid coordinate overflow');
  const region=regions.find(r=>within(bedX,bedY,r,.00001));
  if(!region){points.push(Object.freeze({x,y,nozzleX,nozzleY}));continue;}
  const alternatives=[[region.min[0],bedY],[bedX,region.min[1]],[bedX,region.max[1]],[region.max[0],bedY]];
  if(y%2)[alternatives[0],alternatives[3]]=[alternatives[3],alternatives[0]];
  const valid=alternatives.filter(([bx,by])=>circle?Math.hypot(bx-circle.origin[0],by-circle.origin[1])<=circle.radius:within(bx,by,{min:[p.min_x,p.min_y],max:[p.max_x,p.max_y]},.000001));
  if(!valid.length)throw new RangeError('No valid faulty region substitute');
  for(const [bx,by] of valid){const nx=bx-offsets[0],ny=by-offsets[1];if(![nx,ny].every(Number.isFinite))throw new RangeError('Faulty region coordinate overflow');points.push(Object.freeze({x,y,nozzleX:nx,nozzleY:ny}));}
 }
 if(external){const nozzleX=reference![0]-offsets[0],nozzleY=reference![1]-offsets[1];if(![nozzleX,nozzleY].every(Number.isFinite))throw new RangeError('Reference coordinate overflow');points.push(Object.freeze({x:-1,y:-1,nozzleX,nozzleY}));}
 return Object.freeze({reference,external,circular:!!circle,mesh:p,horizontalHeight:options.horizontalHeight,travelSpeed:options.travelSpeed,points:Object.freeze(points)});
}
export async function measureProbeGrid(plan:ReturnType<typeof planProbeGrid>,port:{position():readonly number[];move(target:readonly number[],speed:number):Promise<void>;probe():Promise<number>},signal:AbortSignal){
 let referenceHeight:number|undefined;
 const counts=Array.from({length:plan.mesh.y_count},()=>Array<number>(plan.mesh.x_count).fill(0));
 const matrix=Array.from({length:plan.mesh.y_count},()=>Array<number>(plan.mesh.x_count));
 for(const point of plan.points){
  signal.throwIfAborted();const start=port.position(),raised=[...start];raised[2]=Math.max(start[2],plan.horizontalHeight);
  await port.move(raised,plan.travelSpeed);const xy=[...raised];xy[0]=point.nozzleX;xy[1]=point.nozzleY;await port.move(xy,plan.travelSpeed);
  // Never lower during XY travel; approach the configured probe height only
  // once the nozzle is over the next measurement point.
  xy[2]=plan.horizontalHeight;await port.move(xy,plan.travelSpeed);
  const z=await port.probe();if(!Number.isFinite(z))throw new Error('Invalid grid probe height');if(point.x<0)referenceHeight=z;else {matrix[point.y][point.x]=(matrix[point.y][point.x]??0)+z;counts[point.y][point.x]++;}
 }
 signal.throwIfAborted();const finish=[...port.position()];finish[2]=Math.max(finish[2],plan.horizontalHeight);await port.move(finish,plan.travelSpeed);signal.throwIfAborted();
 for(let y=0;y<matrix.length;y++)for(let x=0;x<matrix[y].length;x++)if(counts[y][x])matrix[y][x]/=counts[y][x];
 if(plan.circular)for(const row of matrix){
  const first=row.findIndex(Number.isFinite);let last=row.length-1;while(last>=0&&!Number.isFinite(row[last]))last--;
  if(first<0)throw new Error('Missing circular probe row');
  for(let x=0;x<first;x++)row[x]=row[first];for(let x=last+1;x<row.length;x++)row[x]=row[last];
 }
 if(plan.external){if(referenceHeight===undefined)throw new Error('Missing reference measurement');for(const row of matrix)for(let x=0;x<row.length;x++)row[x]-=referenceHeight;}
 const mesh=new BedMesh(plan.mesh,matrix);if(plan.reference&&!plan.external)mesh.setZeroReference(...plan.reference);return mesh;
}
