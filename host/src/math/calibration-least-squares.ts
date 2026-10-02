import {Matrix,SingularValueDecomposition} from 'ml-matrix';

/** Bounded local least squares for calibration workers, never the motion thread.
 * Central differences and column scaling avoid squaring the Jacobian condition.
 * Convergence describes the optimizer, not measurement quality or physical safety.
 */
export function calibrationLeastSquares(keys:readonly string[],initial:Readonly<Record<string,number>>,residuals:(p:Readonly<Record<string,number>>)=>number[],maximumRounds=100){
 if(!Number.isSafeInteger(maximumRounds)||maximumRounds<1||maximumRounds>100)throw new RangeError('Invalid calibration iteration budget');
 let parameters={...initial},evaluations=0,rounds=0,stepSum=Infinity,condition=Infinity;
 const evaluate=(p:Readonly<Record<string,number>>)=>{
  const r=residuals(p);evaluations++;
  if(r.length<keys.length||!r.every(Number.isFinite))throw new RangeError('Invalid calibration residuals');return r;
 };
 const objective=(r:number[])=>{const e=r.reduce((s,v)=>s+v*v,0);if(!Number.isFinite(e))throw new RangeError('Nonfinite calibration objective');return e;};
 let r=evaluate(parameters),error=objective(r);
 for(;rounds<maximumRounds;rounds++){
  const columns=keys.map(key=>{
   const h=Math.cbrt(Number.EPSILON)*Math.max(1,Math.abs(parameters[key]));
   const a=evaluate({...parameters,[key]:parameters[key]+h}),b=evaluate({...parameters,[key]:parameters[key]-h});
   if(a.length!==r.length||b.length!==r.length)throw new RangeError('Calibration residual dimension changed');
   return a.map((v,i)=>(v-b[i])/(2*h));
  });
  const scales=columns.map(c=>Math.hypot(...c));
  if(scales.some(s=>!Number.isFinite(s)||s===0))throw new RangeError('Insufficient independent calibration constraints');
  const svd=new SingularValueDecomposition(new Matrix(columns.map((c,i)=>c.map(v=>v/scales[i]))).transpose());
  condition=svd.condition;
  // Relative cutoff includes finite-difference noise; machine-epsilon rank is too permissive.
  if(!Number.isFinite(condition)||condition>1e8)throw new RangeError('Insufficient independent calibration constraints');
  const step=svd.solve(Matrix.columnVector(r.map(v=>-v))).to1DArray().map((v,i)=>v/scales[i]);
  if(!step.every(Number.isFinite))throw new RangeError('Nonfinite calibration step');
  stepSum=step.reduce((s,v)=>s+Math.abs(v),0);
  if(stepSum<1e-7)return {parameters,rounds,evaluations,stepSum,error,condition,converged:true,reason:'step_threshold' as const};
  let accepted=false;
  for(let scale=1;scale>=2**-20;scale/=2){
   const candidate={...parameters};keys.forEach((key,i)=>candidate[key]+=scale*step[i]);
   let next:number[],nextError:number;
   try{next=evaluate(candidate);if(next.length!==r.length)throw new Error('Calibration residual dimension changed');nextError=objective(next);}
   catch(e){if(e instanceof RangeError)continue;throw e;}
   if(nextError<error){parameters=candidate;r=next;error=nextError;accepted=true;break;}
  }
  if(!accepted)return {parameters,rounds,evaluations,stepSum,error,condition,converged:false,reason:'line_search_failed' as const};
 }
 return {parameters,rounds,evaluations,stepSum,error,condition,converged:false,reason:'round_limit' as const};
}
