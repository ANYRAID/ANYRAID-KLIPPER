import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SkewCorrection,measuredSkew} from '../src/motion/skew.ts';
const reference=JSON.parse(readFileSync(new URL('../contracts/skew-reference.json',import.meta.url),'utf8'));
test('skew forward and inverse preserve original binary64 operations and extrusion',()=>{
 for(const row of reference.rows){const skew=new SkewCorrection(row.factors);assert.deepEqual(skew.apply(row.position),row.forward);assert.deepEqual(skew.unapply(row.forward),row.inverse);for(let axis=0;axis<4;axis++)assert(Math.abs(row.inverse[axis]-row.position[axis])<=2e-13);}
 const factors={xy:.01,xz:.02,yz:.03},skew=new SkewCorrection(factors);factors.xy=100;assert.equal(skew.factors.xy,.01);assert(Object.isFrozen(skew.factors));
 assert.throws(()=>new SkewCorrection({xy:NaN,xz:0,yz:0}));assert.throws(()=>skew.apply([0,1,Infinity,0]));assert.throws(()=>skew.apply([0,1,2]));assert.throws(()=>new SkewCorrection({xy:1e308,xz:0,yz:0}).apply([0,100,0,0]),/overflow/);
});
test('measured skew agrees with original and remains scale invariant at extreme finite lengths',()=>{
 for(const row of reference.measurements){const [a,b,d]=row.lengths,value=measuredSkew(a,b,d);assert(Math.abs(value-row.factor)<=2e-14*Math.max(1,Math.abs(row.factor)));for(const scale of [1e-200,1e200])assert(Math.abs(measuredSkew(a*scale,b*scale,d*scale)-value)<=2e-14*Math.max(1,Math.abs(value)));assert(Math.abs(measuredSkew(b,a,d)+value)<=2e-14);}
 assert.equal(measuredSkew(Math.SQRT2,Math.SQRT2,1),0);
 for(const lengths of [[0,1,1],[1,1,1],[1,1,2],[3,1,1],[NaN,1,1],[Infinity,1,1],[1e308,1e308,5e-324]])assert.throws(()=>measuredSkew(lengths[0],lengths[1],lengths[2]));
});
