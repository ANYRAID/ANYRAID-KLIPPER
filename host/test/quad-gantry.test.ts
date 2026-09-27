import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {planQuadGantry} from '../src/motion/quad-gantry.ts';
const ids=['z','z1','z2','z3'],corners=[[0,0],[100,100]],xy=[[0,0],[0,100],[100,100],[100,0]];
const near=(a:number,b:number,tolerance=1e-10)=>assert(Math.abs(a-b)<=tolerance,`${a} != ${b}`);
const reference=JSON.parse(readFileSync(new URL('../contracts/quad-gantry-reference.json',import.meta.url),'utf8'));
test('four-rail geometry matches actual frozen Python probe_finalize corrections and motor travel',()=>{
 for(const c of reference.cases){const p=planQuadGantry(c.samples,c.corners,ids,5,10);p.adjustments.forEach((a,i)=>near(a.adjustment,c.adjustments[i]));near(p.adjustments.reduce((sum,a)=>sum+a.adjustment,0),0);
  const minimum=Math.min(...c.adjustments);near(p.finalZ,5-minimum);for(const [i,id] of ids.entries())near(p.segments.filter(s=>s.motors.includes(id)).reduce((sum,s)=>sum+s.distance,0),c.adjustments[i]-minimum);
 }
});
test('anchored bilinear interpolation retains analytic twist after coordinate translation',()=>{
 for(const shift of [0,1e6,1e9]){const heights=xy.map(([x,y])=>.003*x-.002*y+.00002*x*y+.88),points=xy.map(([x,y],i)=>[x+shift,y+shift,heights[i]]),mean=heights.reduce((a,b)=>a+b/4,0);
  const p=planQuadGantry(points,corners.map(([x,y])=>[x+shift,y+shift]),ids,5,10);p.adjustments.forEach((a,i)=>near(a.adjustment,heights[i]-mean));
 }
 const flat=planQuadGantry(xy.map(([x,y])=>[x,y,.88]),corners,ids,1,1);assert(flat.segments.every(s=>s.distance===0));assert.equal(flat.finalZ,1);
});
test('full motor travel is bounded even when maximum positive mean correction would pass',()=>{
 const points=xy.map(([x,y],i)=>[x,y,[-3,1,1,1][i]]);
 assert.throws(()=>planQuadGantry(points,corners,ids,5,3),/travel limit/);
 assert.equal(planQuadGantry(points,corners,ids,5,4).maximumMotorTravel,4);
});
test('invalid or unobservable quad geometry never returns a motor plan',()=>{
 const points=xy.map(([x,y])=>[x,y,0]);
 for(const invalid of [points.slice(0,3),points.map((p,i)=>i===3?[p[0],p[1]+1,p[2]]:p),points.map((p,i)=>i===2?[p[0],NaN,p[2]]:p),[points[1],points[0],points[2],points[3]]])assert.throws(()=>planQuadGantry(invalid,corners,ids,5,10));
 assert.throws(()=>planQuadGantry(points,[[0,0],[0,100]],ids,5,10));assert.throws(()=>planQuadGantry(points,corners,['z','z','z2','z3'],5,10));
 assert.throws(()=>planQuadGantry(xy.map(([x,y],i)=>[x,y,i]),corners,ids,1e20,10),/representable/);
});
