import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {planZTilt} from '../src/motion/z-tilt.ts';
const reference=JSON.parse(readFileSync(new URL('../contracts/z-tilt-reference.json',import.meta.url),'utf8'));
const near=(a:number,b:number)=>assert(Math.abs(a-b)<1e-10,`${a} != ${b}`);
test('Z tilt fit, individual motor travel and final coordinate match frozen Python execution',()=>{
 for(const c of reference.cases){const p=planZTilt(c.samples,c.motors,c.currentZ,10);
  if(c.motors.length>2)for(const k of ['x','y','z'] as const)near(p.fit[k],c.fit[k]);
  p.adjustments.forEach((m,i)=>near(m.adjustment,c.adjustments[i]));assert.equal(p.segments.length,c.segments.length);
  p.segments.forEach((s,i)=>{assert.deepEqual([...s.motors].sort(),[...c.segments[i].motors].sort());near(s.targetZ,c.segments[i].targetZ);near(s.distance,c.segments[i].distance);});near(p.finalZ,c.finalZ);
  const minimum=Math.min(...p.adjustments.map(m=>m.adjustment));
  for(const m of p.adjustments){const travel=p.segments.filter(s=>s.motors.includes(m.id)).reduce((sum,s)=>sum+s.distance,0);near(travel,m.adjustment-minimum);assert(travel>=0&&travel<=10);}
  assert(Object.isFrozen(p)&&Object.isFrozen(p.segments));
 }
});
const samples=[[0,0,0],[100,0,1],[0,100,0]],motors=[{id:'z',x:0,y:0},{id:'z1',x:100,y:0}];
test('Z tilt bounds and representability reject unsafe plans before any motor operation',()=>{
 assert.throws(()=>planZTilt(samples,motors,5,.5),/travel limit/);
 assert.throws(()=>planZTilt(samples,motors,1e20,10),/representable/);
 assert.throws(()=>planZTilt([[0,0,0],[0,0,1]],motors,5,10),/separation/);
 assert.throws(()=>planZTilt(samples,[motors[0],motors[0]],5,10));
 assert.throws(()=>planZTilt(samples,[motors[0],{id:'z1',x:0,y:0}],5,10),/distinct/);
 for(const bad of [NaN,Infinity,-Infinity]){assert.throws(()=>planZTilt(samples,motors,bad,10));assert.throws(()=>planZTilt([[bad,0,0],[1,0,1]],motors,5,10));}
 for(const bound of [0,-1,NaN,Infinity])assert.throws(()=>planZTilt(samples,motors,5,bound));
});
test('flat bed and equal corrections preserve stable motor order and zero physical travel',()=>{
 assert.equal(reference.knownIncorrectFlat.legacyFit.x,.0025);
 const p=planZTilt(reference.knownIncorrectFlat.samples,motors,5,1);
 assert.deepEqual(p.segments,[{motors:['z'],targetZ:5,distance:0}]);near(p.finalZ,4.75);
});

test('centered fit recovers an analytic plane under coordinate translation',()=>{
 for(const shift of [0,1000,1e6]){
  const locations=[[0,0],[200,0],[0,200],[200,200]],points=locations.map(([x,y])=>[x+shift,y+shift,.001*x-.002*y+.25]);
  const p=planZTilt(points,locations.map(([x,y],i)=>({id:'z'+i,x:x+shift,y:y+shift})),5,1);
  near(p.fit.x,.001);near(p.fit.y,-.002);p.adjustments.forEach((a,i)=>near(a.adjustment,.001*locations[i][0]-.002*locations[i][1]+.25));
 }
});

test('collinear measurements refuse unobservable motor slopes',()=>{assert.throws(()=>planZTilt([[0,0,0],[100,0,1]],[{id:'z',x:0,y:0},{id:'z1',x:0,y:100}],5,10),/observable/);});
