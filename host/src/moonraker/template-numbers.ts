import {parsePythonFloat} from './config-reader.ts';
import {roundHistoryDecimal} from './history-round.ts';
/** Jinja do_float behavior for primitive JS inputs. The default is returned
 * unchanged, while successful conversion has Python float semantics. A future
 * typed bridge must carry that type separately from the resulting Number. */
export function templateFloat(value:unknown,defaultValue:unknown=0):unknown{
 if(typeof value==='number')return value;
 if(typeof value==='boolean')return Number(value);
 if(typeof value==='bigint'){const number=Number(value);if(!Number.isFinite(number))throw new RangeError('Template float overflow');return number;}
 if(typeof value==='string'){try{return parsePythonFloat(value);}catch{return defaultValue;}}
 return defaultValue;
}
/** Jinja do_round for explicitly floating-point operands. This API never
 * infers a Python integer from Number.isInteger; integer operands need a typed
 * bridge. Nonfinite common rounding remains nonfinite until the output guard. */
export function templateRoundFloat(value:number,precision=0,method='common'):number{
 if(!['common','ceil','floor'].includes(method))throw new RangeError('Invalid template rounding method');
 if(typeof value!=='number'||!Number.isSafeInteger(precision))throw new TypeError('Invalid template rounding operand');
 if(method==='common'){
  if(!Number.isFinite(value)||value===0)return value;
  // toFixed uses exact binary64 decimal rounding, except exact half ties.
  // For p decimal places, a binary-representable tie is an odd / 2^(p+1).
  // Keep both integer products exact; outside that range use the rational path.
  if(precision>=0&&precision<=15&&Math.abs(value)*10**precision<2**50){
   const shifted=Math.abs(value)*2**(precision+1);
   if(Number.isInteger(shifted)&&shifted%2===1){const lower=(shifted*5**precision-1)/2;return Math.sign(value)*(lower+lower%2)/10**precision;}
   return Number(value.toFixed(precision));
  }
  return roundHistoryDecimal(value,precision);
 }
 if(!Number.isFinite(value)||precision>308)throw new RangeError('Template rounding overflow');
 const factor=precision>=0?Number(`1e${precision}`):10**precision;
 if(factor===0)throw new RangeError('Template rounding division by zero');
 const scaled=value*factor;if(!Number.isFinite(scaled))throw new RangeError('Template rounding overflow');
 const rounded=method==='ceil'?Math.ceil(scaled):Math.floor(scaled);
 // Positive precision divides two Python integers, not two already rounded
 // binary64 operands. Decimal conversion performs one final rounding.
 const result=precision>=0?Number(`${BigInt(rounded)}e-${precision}`):(rounded===0?0:rounded)/factor;
 return result;
}
