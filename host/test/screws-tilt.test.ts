import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {calculateScrewTilt} from '../src/motion/screws-tilt.ts';
const reference=JSON.parse(readFileSync(new URL('../contracts/screws-tilt-reference.json',import.meta.url),'utf8'));
test('screw directions and displayed turns match original Python for all eight threads',()=>{
 for(const row of reference.rows){const result=calculateScrewTilt(row.heights,row.thread,row.direction??undefined);assert.deepEqual(result.results.map(({turns,...rest})=>rest),row.results);assert.equal(result.base,row.results.findIndex((r:any)=>r.is_base));assert.equal(result.error,false);}
});
test('screw tolerance is explicit, ties select first base and invalid arithmetic is rejected',()=>{
 assert.equal(calculateScrewTilt([0,0,.0001],'CW-M3',undefined,0).error,true);assert.equal(calculateScrewTilt([0,0,.001],'CW-M3',undefined,.001).error,false);
 assert.equal(calculateScrewTilt([1,1,0],'CW-M3','CW').base,0);assert.equal(calculateScrewTilt([0,0,1],'CW-M3','CCW').base,0);
 for(const heights of [[0,1],[0,NaN,1],[1e308,-1e308,0],[0,1e20,0],Array(100).fill(0)])assert.throws(()=>calculateScrewTilt(heights,'CW-M3'));
 assert.throws(()=>calculateScrewTilt([0,0,0],'CW-M3',undefined,-1));
});
