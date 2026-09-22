// GPL-3.0-or-later. Preserve Python integer arithmetic before float scaling.
import {motanDerivative,motanCombine,motanNorm2,motanSmooth,motanIntegral,type MotanCombination} from './derived-math.ts';
import {motanScalarBytes,type MotanScalar} from './table.ts';
export type MotanScalarSeries=Float64Array|readonly MotanScalar[];
function validate(data:MotanScalarSeries):void{
 if((!Array.isArray(data)&&!(data instanceof Float64Array))||data.length>2000000)throw new Error('Invalid Motan scalar series');
 for(const value of data)if(typeof value!=='bigint'&&typeof value!=='boolean'&&(typeof value!=='number'||!Number.isFinite(value)))throw new Error('Motan arithmetic requires numeric scalars');
}
function checked(value:number):number{if(!Number.isFinite(value))throw new Error('Motan derived result exceeds finite range');return value;}
function mixedBinary(a:MotanScalar,b:MotanScalar,plus:boolean,typedNumbers:boolean):number{
 if(!typedNumbers)throw new Error('Ambiguous mixed Motan integer/Number arithmetic');
 const first=checked(Number(a)),second=checked(Number(b));
 return checked(plus?first+second:first-second);
}
function binary(a:MotanScalar,b:MotanScalar,plus:boolean,typedNumbers=false):number|bigint{
 if(typeof a==='boolean')a=typeof b==='number'?Number(a):(a?1n:0n);if(typeof b==='boolean')b=typeof a==='number'?Number(b):(b?1n:0n);
 if(typeof a==='bigint'&&typeof b==='bigint')return plus?a+b:a-b;
 // Legacy Number values may be integer tokens. Convert mixed operands only
 // when the caller guarantees that Number means a genuine float.
 if(typeof a==='bigint'||typeof b==='bigint')return mixedBinary(a,b,plus,typedNumbers);
 return checked(plus?(a as number)+(b as number):(a as number)-(b as number));
}
function numeric(data:MotanScalarSeries):data is Float64Array|readonly number[]{return data instanceof Float64Array||data.every(value=>typeof value==='number');}
const squareOverflow=1n<<512n;
const floatOverflow=1n<<1024n;
const longMin=-(1n<<63n),longMax=(1n<<63n)-1n;
/** One rounding of integer sum / positive sample count. The denominator is at
 * most two million, so a nonzero quotient cannot be subnormal. */
function integerMean(sum:bigint,count:number):number{
 if(sum===0n)return 0;const negative=sum<0n;let numerator=negative?-sum:sum,denominator=BigInt(count);
 let exponent=numerator.toString(2).length-denominator.toString(2).length;
 if(exponent>=0?numerator<(denominator<<BigInt(exponent)):(numerator<<BigInt(-exponent))<denominator)exponent--;
 if(exponent>1023)throw new Error('Motan derived result exceeds finite range');
 const shift=exponent-52;if(shift>=0)denominator<<=BigInt(shift);else numerator<<=BigInt(-shift);
 let quotient=numerator/denominator;const remainder=numerator%denominator;
 if(remainder*2n>denominator||remainder*2n===denominator&&(quotient&1n)!==0n)quotient++;
 return checked((negative?-1:1)*Number(quotient)*2**shift);
}
/** CPython 3.12, 64-bit C long: the first overflow exits the integer fast
 * loop permanently. In the float fast loop, only float terms compensate;
 * small ints add directly and a wide int flushes compensation and exits.
 * https://github.com/python/cpython/blob/v3.12.13/Python/bltinmodule.c */
function scalarMean(data:MotanScalarSeries,typed:boolean):number{
 let integer=0n,high=0,low=0,floating=false,fast=true;
 const hasNumber=data.some(value=>typeof value==='number');
 for(const value of data){
  if(typeof value!=='number'){
   if(hasNumber&&!typed)throw new Error('Ambiguous mixed Motan integer/Number sum');
   const item=typeof value==='boolean'?(value?1n:0n):value as bigint;
   if(!floating){const next=integer+item;if(item<longMin||item>longMax||next<longMin||next>longMax)fast=false;integer=next;continue;}
   if(fast&&(item<longMin||item>longMax)){if(low&&Number.isFinite(low))high=checked(high+low);low=0;fast=false;}
   high=checked(high+checked(Number(item)));continue;
  }
  if(!floating){high=checked(checked(Number(integer))+value);floating=true;continue;}
  const next=checked(high+value);
  if(fast)low+=Math.abs(high)>=Math.abs(value)?(high-next)+value:(value-next)+high;
  high=next;
 }
 if(!floating)return integerMean(integer,data.length);
 if(fast&&low&&Number.isFinite(low))high=checked(high+low);
 return checked(high/data.length);
}
/** Inputs are explicit int/bool/float when typedNumbers is true. Legacy
 * ambiguous mixed sums remain rejected instead of guessing token kinds. */
export function motanScalarIntegral(data:MotanScalarSeries,segmentTime:number,reference?:MotanScalarSeries,halfLife=.015,maxBytes=64*1024**2,typedNumbers=false):Float64Array{
 if(!Number.isSafeInteger(maxBytes)||maxBytes<0||maxBytes>1024**3||typeof typedNumbers!=='boolean')throw new Error('Invalid Motan scalar integral budget or types');
 if(data.length*8>maxBytes)throw new Error('Motan scalar result memory limit');
 if(data instanceof Float64Array&&(reference===undefined||reference instanceof Float64Array))return motanIntegral(data,segmentTime,reference,halfLife);
 validate(data);if(reference)validate(reference);
 if(!data.length||!Number.isFinite(segmentTime)||segmentTime<=0||!Number.isFinite(halfLife)||halfLife<0||reference&&reference.length!==data.length)throw new Error('Invalid Motan scalar integral samples, reference or time');
 if(numeric(data)&&(reference===undefined||numeric(reference)))return motanIntegral(data,segmentTime,reference,halfLife);
 let offset=scalarMean(data,typedNumbers),total=0,sourceWeight=1,referenceWeight=0;
 if(reference){const first=reference[0],last=reference.at(-1)!;
  const difference=binary(last,first,false,typedNumbers);
  offset=checked(offset-checked(Number(difference))/(data.length*segmentTime));total=checked(Number(first));
  if(halfLife)sourceWeight=Math.exp(Math.log(.5)*segmentTime/halfLife);referenceWeight=1-sourceWeight;
 }
 const result=new Float64Array(data.length);
 for(let i=0;i<data.length;i++){
  total=checked(total+checked((checked(Number(data[i]))-offset)*segmentTime));
  if(reference)total=checked(sourceWeight*total+referenceWeight*checked(Number(reference[i])));
  result[i]=total;
 }
 return result;
}
/** Integer weighting precedes conversion; accumulation is sequential float
 * addition, including the original asymmetric weights at truncated edges. */
export function motanScalarSmooth(data:MotanScalarSeries,segmentTime:number,smoothTime=.01,maxBytes=64*1024**2):Float64Array{
 if(!Number.isSafeInteger(maxBytes)||maxBytes<0||maxBytes>1024**3)throw new Error('Invalid Motan scalar smoothing budget');
 if(data.length*8>maxBytes)throw new Error('Motan scalar result memory limit');
 if(data instanceof Float64Array)return motanSmooth(data,segmentTime,smoothTime);
 validate(data);if(numeric(data))return motanSmooth(data,segmentTime,smoothTime);
 if(!Number.isFinite(segmentTime)||segmentTime<=0||!Number.isFinite(smoothTime)||smoothTime<0)throw new Error('Invalid Motan smoothing time or segment');
 const value=.5*smoothTime/segmentTime,floor=Math.floor(value),half=value-floor===.5?(floor%2?floor+1:floor):Math.round(value);
 if(!Number.isSafeInteger(half)||half<1||half>1000000||data.length*2*half>50000000)throw new Error('Motan smoothing resolution or work limit exceeded');
 const result=new Float64Array(data.length),inverse=1/(half*(half+1));
 for(let i=0;i<data.length;i++){
  const begin=Math.max(0,i-half),end=Math.min(data.length,i+half);let total=0;
  for(let j=begin,k=0;j<end;j++,k++){
   const weight=Math.min(k+1,2*half-k),sample=data[j];let weighted:number;
   if(typeof sample==='bigint'){
    if(sample>=floatOverflow||sample<=-floatOverflow)throw new Error('Motan derived result exceeds finite range');
    weighted=checked(Number(sample*BigInt(weight)));
   }else weighted=checked(Number(sample)*weight);
   total=checked(total+weighted);
  }
  result[i]=checked(total*inverse);
 }
 return result;
}
/** Python squares each integer exactly, then adds each square to a floating
 * accumulator in source order. Do not convert before squaring or sum integers
 * before conversion: either changes the rounding compared with the source. */
export function motanScalarNorm2(series:readonly MotanScalarSeries[],maxBytes=64*1024**2):Float64Array{
 if(!Array.isArray(series)||series.length<2||series.length>3)throw new Error('Motan norm requires two or three datasets');
 if(!Number.isSafeInteger(maxBytes)||maxBytes<0||maxBytes>1024**3)throw new Error('Invalid Motan scalar norm budget');
 if(series.every(data=>data instanceof Float64Array)){
  if(series[0].length*8>maxBytes)throw new Error('Motan scalar result memory limit');
  return motanNorm2(series);
 }
 for(const data of series)validate(data);
 const length=series[0].length;if(series.some(data=>data.length<length))throw new Error('Motan norm source is shorter than first dataset');
 if(length*8>maxBytes)throw new Error('Motan scalar result memory limit');
 if(series.every(numeric))return motanNorm2(series);
 const result=new Float64Array(length);
 for(let i=0;i<length;i++){
  let total=0;
  for(const data of series){const value=data[i];let square:number;
   if(typeof value==='bigint'){
    // Such a square cannot convert to a finite double. Reject before allocating
    // an arbitrarily large product supplied by a direct caller.
    if(value>=squareOverflow||value<=-squareOverflow)throw new Error('Motan derived result exceeds finite range');
    square=checked(Number(value*value));
   }else{const number=Number(value);square=checked(number*number);}
   total=checked(total+square);
  }
  result[i]=Math.sqrt(total);
 }
 return result;
}
/** Integer subtraction happens before conversion and multiplication. */
export function motanScalarDerivative(data:MotanScalarSeries,segmentTime:number,typedNumbers=false):Float64Array{
 if(typeof typedNumbers!=='boolean')throw new Error('Invalid Motan derivative type mode');
 if(data instanceof Float64Array)return motanDerivative(data,segmentTime);
 validate(data);if(numeric(data))return motanDerivative(data,segmentTime);
 if(!Number.isFinite(segmentTime)||segmentTime<=0||data.length<2)throw new Error('Invalid Motan scalar derivative samples or segment');
 const result=new Float64Array(data.length),inverse=1/segmentTime;
 for(let i=1;i<data.length;i++)result[i]=checked(checked(Number(binary(data[i],data[i-1],false,typedNumbers)))*inverse);
 result[0]=result[1];return result;
}
/** Deviation and unscaled sums retain exact integer results for downstream
 * derivatives. CoreXY converts only after the exact add/subtract, like Python. */
export function motanScalarCombine(first:MotanScalarSeries,second:MotanScalarSeries,kind:MotanCombination,maxBytes=64*1024**2,typedNumbers=false):Float64Array|readonly MotanScalar[]{
 if(typeof typedNumbers!=='boolean'||!Number.isSafeInteger(maxBytes)||maxBytes<0||maxBytes>1024**3||!['deviation','corexy_x','corexy_y','kin_x','kin_y'].includes(kind))throw new Error('Invalid Motan scalar combination or budget');
 const length=Math.min(first.length,second.length);
 if(length*8>maxBytes)throw new Error('Motan scalar result memory limit');
 if(first instanceof Float64Array&&second instanceof Float64Array)return motanCombine(first,second,kind);
 validate(first);validate(second);
 if(numeric(first)&&numeric(second))return motanCombine(first,second,kind);
 const plus=kind==='corexy_x'||kind==='kin_x',half=kind==='corexy_x'||kind==='corexy_y';
 if(half){const result=new Float64Array(length);for(let i=0;i<length;i++)result[i]=checked(.5*checked(Number(binary(first[i],second[i],plus,typedNumbers))));return result;}
 const result:MotanScalar[]=new Array(length);let bytes=0;
 for(let i=0;i<length;i++){const value=binary(first[i],second[i],plus,typedNumbers);bytes+=motanScalarBytes(value);if(bytes>maxBytes)throw new Error('Motan scalar result memory limit');result[i]=value;}
 return Object.freeze(result);
}
