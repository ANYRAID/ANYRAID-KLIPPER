/** Round an exact binary64 value as CPython round(value, ndigits), ties to even.
 * This runs at history commit time, never in the motion or sample update path. */
export function roundHistoryDecimal(value:number,places:number|null):number{
 if(typeof value!=='number'||!Number.isFinite(value))throw new RangeError('Nonfinite history total');
 if(places===null)return value;
 if(!Number.isSafeInteger(places))throw new RangeError('Invalid history precision');
 if(places>323||value===0)return value;
 if(places< -308)return value<0?-0:0;
 const view=new DataView(new ArrayBuffer(8));view.setFloat64(0,value);
 const bits=view.getBigUint64(0),exponent=Number((bits>>52n)&2047n),negative=(bits>>63n)!==0n;
 let numerator=(bits&((1n<<52n)-1n))+(exponent?1n<<52n:0n),denominator=1n;
 const power=exponent?exponent-1075:-1074;
 if(power>=0)numerator<<=BigInt(power);else denominator<<=BigInt(-power);
 if(places>=0)numerator*=10n**BigInt(places);else denominator*=10n**BigInt(-places);
 let quotient=numerator/denominator;const remainder=numerator%denominator;
 if(remainder*2n>denominator||remainder*2n===denominator&&(quotient&1n)!==0n)quotient++;
 const result=Number(`${negative?'-':''}${quotient}e${-places}`);
 if(!Number.isFinite(result))throw new RangeError('History rounding overflow');return result;
}
