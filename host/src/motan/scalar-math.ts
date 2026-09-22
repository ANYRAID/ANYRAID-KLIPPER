// GPL-3.0-or-later. Preserve Python integer arithmetic before float scaling.
import {motanDerivative,motanCombine,motanNorm2,motanSmooth,type MotanCombination} from './derived-math.ts';
import {motanScalarBytes,type MotanScalar} from './table.ts';
export type MotanScalarSeries=Float64Array|readonly MotanScalar[];
function validate(data:MotanScalarSeries):void{
 if((!Array.isArray(data)&&!(data instanceof Float64Array))||data.length>2000000)throw new Error('Invalid Motan scalar series');
 for(const value of data)if(typeof value!=='bigint'&&typeof value!=='boolean'&&(typeof value!=='number'||!Number.isFinite(value)))throw new Error('Motan arithmetic requires numeric scalars');
}
function checked(value:number):number{if(!Number.isFinite(value))throw new Error('Motan derived result exceeds finite range');return value;}
function binary(a:MotanScalar,b:MotanScalar,plus:boolean):number|bigint{
 if(typeof a==='boolean')a=typeof b==='number'?Number(a):(a?1n:0n);if(typeof b==='boolean')b=typeof a==='number'?Number(b):(b?1n:0n);
 if(typeof a==='bigint'&&typeof b==='bigint')return plus?a+b:a-b;
 // JSON decoding currently retains only wide integer tokens as BigInt. A
 // Number paired with BigInt may have been either an int or float token; do
 // not guess and erase a low-order bit. Typed-token propagation is pending.
 if(typeof a==='bigint'||typeof b==='bigint')throw new Error('Ambiguous mixed Motan integer/Number arithmetic');
 return checked(plus?(a as number)+(b as number):(a as number)-(b as number));
}
function numeric(data:MotanScalarSeries):data is Float64Array|readonly number[]{return data instanceof Float64Array||data.every(value=>typeof value==='number');}
const squareOverflow=1n<<512n;
const floatOverflow=1n<<1024n;
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
export function motanScalarDerivative(data:MotanScalarSeries,segmentTime:number):Float64Array{
 if(data instanceof Float64Array)return motanDerivative(data,segmentTime);
 validate(data);if(numeric(data))return motanDerivative(data,segmentTime);
 if(!Number.isFinite(segmentTime)||segmentTime<=0||data.length<2)throw new Error('Invalid Motan scalar derivative samples or segment');
 const result=new Float64Array(data.length),inverse=1/segmentTime;
 for(let i=1;i<data.length;i++)result[i]=checked(checked(Number(binary(data[i],data[i-1],false)))*inverse);
 result[0]=result[1];return result;
}
/** Deviation and unscaled sums retain exact integer results for downstream
 * derivatives. CoreXY converts only after the exact add/subtract, like Python. */
export function motanScalarCombine(first:MotanScalarSeries,second:MotanScalarSeries,kind:MotanCombination,maxBytes=64*1024**2):Float64Array|readonly MotanScalar[]{
 if(!Number.isSafeInteger(maxBytes)||maxBytes<0||maxBytes>1024**3||!['deviation','corexy_x','corexy_y','kin_x','kin_y'].includes(kind))throw new Error('Invalid Motan scalar combination or budget');
 const length=Math.min(first.length,second.length);
 if(length*8>maxBytes)throw new Error('Motan scalar result memory limit');
 if(first instanceof Float64Array&&second instanceof Float64Array)return motanCombine(first,second,kind);
 validate(first);validate(second);
 if(numeric(first)&&numeric(second))return motanCombine(first,second,kind);
 const plus=kind==='corexy_x'||kind==='kin_x',half=kind==='corexy_x'||kind==='corexy_y';
 if(half){const result=new Float64Array(length);for(let i=0;i<length;i++)result[i]=checked(.5*checked(Number(binary(first[i],second[i],plus))));return result;}
 const result:MotanScalar[]=new Array(length);let bytes=0;
 for(let i=0;i<length;i++){const value=binary(first[i],second[i],plus);bytes+=motanScalarBytes(value);if(bytes>maxBytes)throw new Error('Motan scalar result memory limit');result[i]=value;}
 return Object.freeze(result);
}
