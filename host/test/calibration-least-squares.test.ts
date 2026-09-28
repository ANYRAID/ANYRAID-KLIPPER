import test from 'node:test';
import assert from 'node:assert/strict';
import {calibrationLeastSquares as solve} from '../src/math/calibration-least-squares.ts';
test('bounded calibration solver reports exhausted budget and rejects nonfinite/rank deficient data',()=>{
 const limited=solve(['x'],{x:10},p=>[p.x*p.x-2],1);
 assert.equal(limited.converged,false);assert.equal(limited.reason,'round_limit');
 assert.throws(()=>solve(['x'],{x:1},()=>[NaN]),/residual/);
 assert.throws(()=>solve(['x','y'],{x:1,y:2},p=>[p.x+p.y,p.x+p.y]),/independent/);
 assert.throws(()=>solve(['x'],{x:1},p=>[p.x],101),/budget/);
});
test('bounded calibration solver backtracks around invalid geometry',()=>{
 const result=solve(['x'],{x:.1},p=>{if(p.x<=0||p.x>4)throw new RangeError('geometry');return [Math.log(p.x)];});
 assert(result.converged);assert(Math.abs(result.parameters.x-1)<1e-7);
});
