// Derived from klippy/mathutil.py; GPL-3.0-or-later.
// Copyright (C) 2018-2019 Kevin O'Connor; 2025-2026 Dmitry Butyugin.
// Keep binary64 and operation order: calibration compatibility is intentional.
export type Vec3 = readonly [number, number, number];
export type Matrix = readonly (readonly number[])[];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
export const dot = (a: Vec3, b: Vec3): number => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
export const magnitudeSquared = (a: Vec3): number => a[0]**2+a[1]**2+a[2]**2;
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0]+b[0], a[1]+b[1], a[2]+b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0]*s, a[1]*s, a[2]*s];

export function trilateration(coords: readonly [Vec3, Vec3, Vec3], radius2: Vec3): Vec3 {
  if (![...coords.flat(), ...radius2].every(Number.isFinite) || radius2.some(r => r < 0))
    throw new RangeError('Sphere coordinates and squared radii must be finite; radii nonnegative');
  const [a,b,c] = coords;
  const s21 = sub(b,a), s31 = sub(c,a);
  const d = Math.sqrt(magnitudeSquared(s21));
  if (d === 0) throw new RangeError('Coincident sphere centers');
  const ex = scale(s21,1/d), i = dot(ex,s31);
  const vey = sub(s31,scale(ex,i));
  const norm = Math.sqrt(magnitudeSquared(vey));
  if (norm === 0) throw new RangeError('Collinear sphere centers');
  const ey = scale(vey,1/norm), ez = cross(ex,ey), j = dot(ey,s31);
  const x = (radius2[0]-radius2[1]+d**2)/(2*d);
  const y = (radius2[0]-radius2[2]-x**2+(x-i)**2+j**2)/(2*j);
  const z = -Math.sqrt(radius2[0]-x**2-y**2);
  const result = add(a,add(scale(ex,x),add(scale(ey,y),scale(ez,z))));
  if (!result.every(Number.isFinite)) throw new RangeError('No finite sphere intersection');
  return result;
}

function shape(a: Matrix): number {
  if (!a.length || !a[0].length) throw new RangeError('Matrix must be nonempty');
  const n = a[0].length;
  if (a.some(row => row.length !== n || !row.every(Number.isFinite)))
    throw new RangeError('Matrix must be rectangular and finite');
  return n;
}
export function transpose(a: Matrix): number[][] {
  const n = shape(a);
  return Array.from({length:n}, (_,i) => a.map(row => row[i]));
}
export function multiply(a: Matrix, b: Matrix): number[][] | null {
  const n = shape(a); shape(b);
  if (n !== b.length) return null;
  const bt = transpose(b);
  return a.map(row => bt.map(col => row.reduce((sum,v,i) => sum+v*col[i],0)));
}
export function multiplyTranspose(a: Matrix): number[][] {
  shape(a);
  const result = a.map((row,i) => a.slice(0,i+1).map(col => row.reduce((sum,v,j) => sum+v*col[j],0)));
  for (let i=0;i<a.length;i++) for (let j=i+1;j<a.length;j++) result[i].push(result[j][i]);
  return result;
}
export function gaussianSolve(a: Matrix, rhs: Matrix, allowUnderdetermined = false): number[][] | null {
  const n = shape(a); shape(rhs);
  if (a.length !== n || rhs.length !== n) throw new RangeError('Incompatible linear system dimensions');
  const m = a.map(row => [...row]), res = rhs.map(row => [...row]);
  for (let i=n-1;i>=0;i--) {
    let j=0;
    for (let k=1;k<=i;k++) if (Math.abs(m[k][i])>Math.abs(m[j][i])) j=k;
    if (i!==j) { [m[i],m[j]]=[m[j],m[i]]; [res[i],res[j]]=[res[j],res[i]]; }
    if (Math.abs(m[i][i])<1e-10 && !allowUnderdetermined) return null;
    const reciprocal = Math.abs(m[i][i])<1e-10 ? 0 : 1/m[i][i];
    m[i] = m[i].slice(0,i).map(v => v*reciprocal);
    res[i] = res[i].map(v => v*reciprocal);
    for (let k=0;k<i;k++) {
      const c=m[k][i];
      m[k]=m[k].slice(0,i).map((v,l) => v-c*m[i][l]);
      res[k]=res[k].map((v,l) => v-c*res[i][l]);
    }
  }
  for (let k=0;k<rhs[0].length;k++) for (let i=1;i<n;i++)
    res[i][k]-=m[i].reduce((sum,v,j) => sum+v*res[j][k],0);
  if (res.some(row => !row.every(Number.isFinite))) throw new RangeError('Nonfinite linear solution');
  return res;
}
export function pseudoInverse(m: Matrix): number[][] | null {
  const mt=transpose(m);
  return gaussianSolve(multiplyTranspose(mt),mt);
}
export function solveLinearEquations(eqs: Matrix, ans: Matrix, allowUnderdetermined=false): number[][] | null {
  const eqst=transpose(eqs), rhs=multiply(eqst,ans);
  if (!rhs) throw new RangeError('Incompatible equation dimensions');
  return gaussianSolve(multiplyTranspose(eqst),rhs,allowUnderdetermined);
}
export function coordinateDescent(adj: readonly string[], initial: Readonly<Record<string,number>>,
  error: (params: Readonly<Record<string,number>>) => number): Record<string,number> {
  const params={...initial};
  if (new Set(adj).size!==adj.length || adj.some(k => !Number.isFinite(params[k])))
    throw new RangeError('Adjustable parameters must be unique and finite');
  const dp=adj.map(() => 1);
  const evaluate=() => {
    const e=error(params);
    if (!Number.isFinite(e)) throw new RangeError('Nonfinite calibration error');
    return e;
  };
  let best=evaluate(), rounds=0;
  while (dp.reduce((a,b) => a+b,0)>0.00001 && rounds<10000) {
    rounds++;
    for (let i=0;i<adj.length;i++) {
      const key=adj[i], orig=params[key];
      params[key]=orig+dp[i];
      let e=evaluate();
      if (e<best) { best=e; dp[i]*=1.1; continue; }
      params[key]=orig-dp[i]; e=evaluate();
      if (e<best) { best=e; dp[i]*=1.1; continue; }
      params[key]=orig; dp[i]*=0.9;
    }
  }
  return params;
}
