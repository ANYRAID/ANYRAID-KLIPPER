// GPL-3.0-or-later. From analyzers.py, copyright (C) 2021 Kevin O'Connor.
export type MotanSeries=readonly number[]|Float64Array;
function validate(data:MotanSeries):void{if((!Array.isArray(data)&&!(data instanceof Float64Array))||data.length>2000000)throw new Error('Invalid Motan numeric series');for(let i=0;i<data.length;i++){const value=data[i];if(typeof value!=='number'||!Number.isFinite(value))throw new Error('Motan analysis requires finite Float64 values');}}
function segment(time:number):void{if(!Number.isFinite(time)||time<=0)throw new Error('Invalid Motan analysis segment time');}
function checked(data:Float64Array):Float64Array{for(let i=0;i<data.length;i++)if(!Number.isFinite(data[i]))throw new Error('Motan derived result exceeds finite range');return data;}
/** CPython 3.12 float sum; retain the final compensation guard.
 * https://github.com/python/cpython/blob/v3.12.13/Python/bltinmodule.c */
function sum(data:MotanSeries):number{let high=0,low=0;for(const value of data){const next=high+value;low+=Math.abs(high)>=Math.abs(value)?(high-next)+value:(value-next)+high;high=next;}if(low&&Number.isFinite(low))high+=low;return high;}
export function motanDerivative(data:MotanSeries,segmentTime:number):Float64Array{
 validate(data);segment(segmentTime);if(data.length<2)throw new Error('Motan derivative needs two samples');const result=new Float64Array(data.length),inverse=1/segmentTime;for(let i=1;i<data.length;i++)result[i]=(data[i]-data[i-1])*inverse;result[0]=result[1];return checked(result);
}
export function motanIntegral(data:MotanSeries,segmentTime:number,reference?:MotanSeries,halfLife=.015):Float64Array{
 validate(data);segment(segmentTime);if(!data.length)throw new Error('Motan integral needs samples');if(!Number.isFinite(halfLife)||halfLife<0)throw new Error('Invalid Motan integral half-life');if(reference){validate(reference);if(reference.length!==data.length)throw new Error('Motan integral reference length mismatch');}
 let offset=sum(data)/data.length,total=0,sourceWeight=1,referenceWeight=0;if(reference){offset-=(reference.at(-1)!-reference[0])/(data.length*segmentTime);total=reference[0];if(halfLife)sourceWeight=Math.exp(Math.log(.5)*segmentTime/halfLife);referenceWeight=1-sourceWeight;}
 const result=new Float64Array(data.length);for(let i=0;i<data.length;i++){total+=(data[i]-offset)*segmentTime;if(reference)total=sourceWeight*total+referenceWeight*reference[i];result[i]=total;}return checked(result);
}
export function motanNorm2(series:readonly MotanSeries[]):Float64Array{
 if(series.length<2||series.length>3)throw new Error('Motan norm requires two or three datasets');for(const data of series)validate(data);const length=series[0].length;if(series.some(data=>data.length<length))throw new Error('Motan norm source is shorter than first dataset');const result=new Float64Array(length);for(let i=0;i<length;i++){let total=0;for(const data of series)total+=data[i]*data[i];result[i]=Math.sqrt(total);}return checked(result);
}
export function motanSmooth(data:MotanSeries,segmentTime:number,smoothTime=.01):Float64Array{
 validate(data);segment(segmentTime);if(!Number.isFinite(smoothTime)||smoothTime<0)throw new Error('Invalid Motan smoothing time');const value=.5*smoothTime/segmentTime,floor=Math.floor(value),half=value-floor===.5?(floor%2?floor+1:floor):Math.round(value);if(!Number.isSafeInteger(half)||half<1||half>1000000||data.length*2*half>50000000)throw new Error('Motan smoothing resolution or work limit exceeded');
 const result=new Float64Array(data.length),inverse=1/(half*(half+1));for(let i=0;i<data.length;i++){const begin=Math.max(0,i-half),end=Math.min(data.length,i+half);let total=0;for(let j=begin,k=0;j<end;j++,k++)total+=data[j]*Math.min(k+1,2*half-k);result[i]=total*inverse;}return checked(result);
}
export type MotanCombination='deviation'|'corexy_x'|'corexy_y'|'kin_x'|'kin_y';
export function motanCombine(first:MotanSeries,second:MotanSeries,kind:MotanCombination):Float64Array{
 validate(first);validate(second);if(!['deviation','corexy_x','corexy_y','kin_x','kin_y'].includes(kind))throw new Error('Invalid Motan combination');const result=new Float64Array(Math.min(first.length,second.length)),plus=kind==='corexy_x'||kind==='kin_x',half=kind==='corexy_x'||kind==='corexy_y';for(let i=0;i<result.length;i++){const value=plus?first[i]+second[i]:first[i]-second[i];result[i]=half?.5*value:value;}return checked(result);
}
