// GPL-3.0-or-later. ZMesh numerical port from extras/bed_mesh.py.
// Original Copyright (C) 2018-2019 Eric Callahan.
export interface BedMeshParameters {min_x:number;max_x:number;min_y:number;max_y:number;x_count:number;y_count:number;mesh_x_pps:number;mesh_y_pps:number;algo:'direct'|'lagrange'|'bicubic';tension:number;}
const lerp=(t:number,a:number,b:number)=>(1-t)*a+t*b;
const clamp=(v:number,low:number,high:number)=>Math.min(high,Math.max(low,v));
export class BedMesh {
 readonly params:Readonly<BedMeshParameters>;readonly width:number;readonly height:number;
 #probed:Float64Array;#mesh:Float64Array;#dx:number;#dy:number;#offsetX=0;#offsetY=0;
 constructor(parameters:BedMeshParameters,matrix:readonly (readonly number[])[]){
  const p={...parameters};for(const n of [p.x_count,p.y_count])if(!Number.isInteger(n)||n<2||n>128)throw new RangeError('Invalid probe count');for(const n of [p.mesh_x_pps,p.mesh_y_pps])if(!Number.isInteger(n)||n<0||n>64)throw new RangeError('Invalid mesh points per segment');
  if(![p.min_x,p.max_x,p.min_y,p.max_y,p.tension].every(Number.isFinite)||p.max_x<=p.min_x||p.max_y<=p.min_y||p.tension<0||p.tension>2||!['direct','lagrange','bicubic'].includes(p.algo))throw new RangeError('Invalid bed mesh parameters');
  if(!p.mesh_x_pps&&!p.mesh_y_pps)p.algo='direct';else if(p.algo==='direct')throw new RangeError('Direct mesh requires zero interpolation points');
  if(p.algo==='bicubic'&&Math.min(p.x_count,p.y_count)<4)p.algo='lagrange';if(p.algo==='lagrange'&&Math.max(p.x_count,p.y_count)>6)throw new RangeError('Lagrange mesh supports at most six probes per axis');
  this.params=Object.freeze(p);this.width=(p.x_count-1)*(p.mesh_x_pps+1)+1;this.height=(p.y_count-1)*(p.mesh_y_pps+1)+1;if(this.width*this.height>1000000)throw new RangeError('Bed mesh cell limit exceeded');
  this.#dx=(p.max_x-p.min_x)/(this.width-1);this.#dy=(p.max_y-p.min_y)/(this.height-1);for(const [low,step,count] of [[p.min_x,this.#dx,this.width],[p.min_y,this.#dy,this.height]]){let previous=low;for(let i=1;i<count;i++){const v=low+step*i;if(!Number.isFinite(v)||v<=previous)throw new RangeError('Bed mesh coordinate resolution exceeded');previous=v;}}
  if(!Array.isArray(matrix)||matrix.length!==p.y_count)throw new RangeError('Invalid probed matrix');this.#probed=new Float64Array(p.x_count*p.y_count);for(let y=0;y<p.y_count;y++){if(!Array.isArray(matrix[y])||matrix[y].length!==p.x_count)throw new RangeError('Invalid probed row');for(let x=0;x<p.x_count;x++){const v=matrix[y][x];if(!Number.isFinite(v))throw new RangeError('Nonfinite probe height');this.#probed[y*p.x_count+x]=v;}}
  this.#mesh=new Float64Array(this.width*this.height);const xm=p.mesh_x_pps+1,ym=p.mesh_y_pps+1;for(let y=0;y<p.y_count;y++)for(let x=0;x<p.x_count;x++)this.#mesh[y*ym*this.width+x*xm]=this.#probed[y*p.x_count+x];
  if(p.algo!=='direct'){
   const interpolate=(index:number,vector:number,axis:0|1)=>{const count=axis?p.y_count:p.x_count,mult=axis?ym:xm,step=axis?this.#dy:this.#dx,low=axis?p.min_y:p.min_x,at=(i:number)=>axis?this.#mesh[i*mult*this.width+vector]:this.#mesh[vector*this.width+i*mult];
    if(p.algo==='lagrange'){const coord=low+step*index;let total=0;for(let i=0;i<count;i++){let numerator=1,denominator=1;const ip=low+step*(i*mult);for(let j=0;j<count;j++)if(j!==i){const jp=low+step*(j*mult);numerator*=coord-jp;denominator*=ip-jp;}total+=at(i)*numerator/denominator;}return total;}
    const segment=Math.floor(index/mult),t=(index-segment*mult)/mult,t2=t*t,t3=t2*t,p0=at(Math.max(0,segment-1)),p1=at(segment),p2=at(segment+1),p3=at(Math.min(count-1,segment+2)),m1=p.tension*(p2-p0),m2=p.tension*(p3-p1);return p1*(2*t3-3*t2+1)+p2*(-2*t3+3*t2)+m1*(t3-2*t2+t)+m2*(t3-t2);
   };
   for(let y=0;y<this.height;y+=ym)for(let x=0;x<this.width;x++)if(x%xm)this.#mesh[y*this.width+x]=interpolate(x,y,0);
   for(let x=0;x<this.width;x++)for(let y=0;y<this.height;y++)if(y%ym)this.#mesh[y*this.width+x]=interpolate(y,x,1);
  }
  if(!this.#mesh.every(Number.isFinite))throw new RangeError('Bed mesh interpolation overflow');
 }
 /** Hot lookup: bilinear interpolation, clamped to the sampled mesh boundary. */
 calcZ(x:number,y:number):number{
  x+=this.#offsetX;y+=this.#offsetY;if(!Number.isFinite(x)||!Number.isFinite(y))throw new RangeError('Invalid mesh query');const p=this.params,xi=clamp(Math.floor((x-p.min_x)/this.#dx),0,this.width-2),yi=clamp(Math.floor((y-p.min_y)/this.#dy),0,this.height-2),tx=clamp((x-(p.min_x+this.#dx*xi))/this.#dx,0,1),ty=clamp((y-(p.min_y+this.#dy*yi))/this.#dy,0,1),base=yi*this.width,z0=lerp(tx,this.#mesh[base+xi],this.#mesh[base+xi+1]),z1=lerp(tx,this.#mesh[base+this.width+xi],this.#mesh[base+this.width+xi+1]),result=lerp(ty,z0,z1);if(!Number.isFinite(result))throw new RangeError('Mesh lookup overflow');return result;
 }
 setOffsets(x:number|null,y:number|null):void{if(x!==null&&!Number.isFinite(x)||y!==null&&!Number.isFinite(y))throw new RangeError('Invalid mesh offset');if(x!==null)this.#offsetX=x;if(y!==null)this.#offsetY=y;}
 /** Validate both new buffers before committing; direct meshes must not alias. */
 setZeroReference(x:number,y:number):void{const offset=this.calcZ(x,y),probed=Float64Array.from(this.#probed,v=>v-offset),mesh=Float64Array.from(this.#mesh,v=>v-offset);if(!probed.every(Number.isFinite)||!mesh.every(Number.isFinite))throw new RangeError('Zero reference overflow');this.#probed=probed;this.#mesh=mesh;}
 meshValues():Float64Array{return this.#mesh.slice();}
 probedValues():Float64Array{return this.#probed.slice();}
 range():[number,number]{let low=Infinity,high=-Infinity;for(const v of this.#mesh){low=Math.min(low,v);high=Math.max(high,v);}return [low,high];}
}
