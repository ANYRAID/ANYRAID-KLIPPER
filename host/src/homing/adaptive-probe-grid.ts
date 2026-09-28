import {planProbeGrid,type ProbeGrid} from './probe-grid.ts';
/** Caller must bind polygons to the selected immutable print file, never to a
 * previous job's retained object status. No motion or config mutation here. */
export function adaptProbeGrid(grid:ProbeGrid,polygons:readonly (readonly (readonly number[])[])[],margin=0):{grid:ProbeGrid;adapted:boolean}{
 if(!Number.isFinite(margin)||margin<0||polygons.length>1024)throw new RangeError('Invalid adaptive mesh input');
 const original=planProbeGrid(grid,[0,0,0]),full=()=>({grid:structuredClone(grid),adapted:false});
 if(!polygons.length)return full();
 let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity,total=0;
 for(const polygon of polygons){
  if(polygon.length<3||polygon.length>4096||(total+=polygon.length)>65536)throw new RangeError('Invalid adaptive object polygon');
  for(const point of polygon){if(point.length!==2||!point.every(Number.isFinite))throw new RangeError('Invalid adaptive object coordinate');minX=Math.min(minX,point[0]);maxX=Math.max(maxX,point[0]);minY=Math.min(minY,point[1]);maxY=Math.max(maxY,point[1]);}
 }
 const p=original.mesh;
 // Objects outside the configured mesh are not silently clipped to a smaller
 // calibration footprint. Preserve full configured coverage in that case.
 if(minX<p.min_x||maxX>p.max_x||minY<p.min_y||maxY>p.max_y)return full();
 minX=Math.max(p.min_x,minX-margin);maxX=Math.min(p.max_x,maxX+margin);minY=Math.max(p.min_y,minY-margin);maxY=Math.min(p.max_y,maxY+margin);
 let nx=Math.ceil(p.x_count*(maxX-minX)/(p.max_x-p.min_x)),ny=Math.ceil(p.y_count*(maxY-minY)/(p.max_y-p.min_y));
 const minimum=Math.max(nx,ny)>6&&Math.min(nx,ny)<4?4:3;nx=Math.max(minimum,nx);ny=Math.max(minimum,ny);if(nx>p.x_count||ny>p.y_count)return full();
 // Keep at least 1 mm between contacts, expanding symmetrically within bounds.
 const expand=(lo:number,hi:number,n:number,low:number,high:number):[number,number]=>{const span=Math.max(hi-lo,n-1);if(span>high-low)return [low,high];const start=Math.min(Math.max((lo+hi-span)/2,low),high-span);return [start,start+span];};
 [minX,maxX]=expand(minX,maxX,nx,p.min_x,p.max_x);[minY,maxY]=expand(minY,maxY,ny,p.min_y,p.max_y);
 const next:ProbeGrid=structuredClone(grid);
 if(grid.circle){
  const radius=Math.hypot(maxX-minX,maxY-minY)/2,origin:[number,number]=[(minX+maxX)/2,(minY+maxY)/2];
  if(radius+Math.hypot(origin[0]-grid.circle.origin[0],origin[1]-grid.circle.origin[1])>=grid.circle.radius)return full();
  // Reserve one extra hundredth per interval: subsequent binary floor must
  // not round the circumscribed grid inward across a polygon corner.
  let count=Math.max(nx,ny);if(count%2===0)count++;const half=(count-1)/2,step=(Math.ceil(radius/half*100)+1)/100,roundedRadius=half*step;
  if(roundedRadius+Math.hypot(origin[0]-grid.circle.origin[0],origin[1]-grid.circle.origin[1])>=grid.circle.radius)return full();
  next.circle={radius:roundedRadius,origin};next.mesh={...p,x_count:count,y_count:count};
 }else next.mesh={...p,min_x:minX,max_x:maxX,min_y:minY,max_y:maxY,x_count:nx,y_count:ny};
 const planned=planProbeGrid(next,[0,0,0]);next.mesh=planned.mesh;
 return {grid:next,adapted:true};
}
