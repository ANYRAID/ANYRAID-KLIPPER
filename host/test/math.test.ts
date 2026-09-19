import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as m from '../src/math/mathutil.ts';
test('trilateration selects lower intersection with sphere residuals', () => {
  const centers: [m.Vec3,m.Vec3,m.Vec3]=[[0,0,0],[2,0,0],[0,2,0]];
  const p=m.trilateration(centers,[3,3,3]);
  assert.deepEqual(p,[1,1,-1]);
  centers.forEach(c => assert.ok(Math.abs(m.magnitudeSquared(m.sub(p,c))-3)<1e-12));
});
test('unreachable or degenerate geometry fails closed', () => {
  for (const centers of [[[0,0,0],[0,0,0],[0,2,0]],[[0,0,0],[1,0,0],[2,0,0]],[[0,0,0],[10,0,0],[0,10,0]]] as [m.Vec3,m.Vec3,m.Vec3][])
    assert.throws(() => m.trilateration(centers,[1,1,1]),RangeError);
});
test('linear systems preserve inputs, pivot, and solve multiple RHS', () => {
  const a=[[0,2],[3,4]], rhs=[[4,2],[11,7]], before=structuredClone([a,rhs]);
  assert.deepEqual(m.gaussianSolve(a,rhs),[[1,1],[2,1]]);
  assert.deepEqual([a,rhs],before);
  assert.equal(m.gaussianSolve([[1,2],[2,4]],[[1],[2]]),null);
  assert.ok(m.gaussianSolve([[1,2],[2,4]],[[1],[2]],true));
  assert.throws(() => m.gaussianSolve([[NaN]],[[1]]),RangeError);
});
test('least squares and pseudoinverse satisfy residual identities', () => {
  const a=[[1,0],[1,1],[1,2]], b=[[1],[3],[5]];
  const x=m.solveLinearEquations(a,b)!;
  assert.ok(Math.abs(x[0][0]-1)<1e-12 && Math.abs(x[1][0]-2)<1e-12);
  const reconstructed=m.multiply(m.multiply(a,m.pseudoInverse(a)!)!,a)!;
  reconstructed.forEach((row,i) => row.forEach((v,j) => assert.ok(Math.abs(v-a[i][j])<1e-12)));
});
test('coordinate descent converges without mutating initial parameters', () => {
  const initial={x:0,y:0,fixed:7};
  const result=m.coordinateDescent(['x','y'],initial,p => (p.x-3)**2+(p.y+2)**2);
  assert.ok(Math.abs(result.x-3)<1e-5 && Math.abs(result.y+2)<1e-5);
  assert.deepEqual(initial,{x:0,y:0,fixed:7});
  assert.equal(result.fixed,7);
  assert.throws(() => m.coordinateDescent(['x'],initial,() => NaN),RangeError);
});
