/** Exact endpoint coverage for stationary trapq rows. A long interval can lose
 * low bits in end-start, making start+duration overshoot the next row. Split
 * only when needed; the final subtraction uses nearby positive numbers. */
export function stationaryRows(from:number,until:number,position:readonly number[]):Float64Array{
 if(!Number.isFinite(from)||from<0||!Number.isFinite(until)||until<=from||until>=1e15||position.length!==3||!position.every(Number.isFinite))throw new RangeError('Invalid stationary interval');
 const span=until-from,row=(start:number,duration:number)=>[start,0,duration,0,...position,0,0,0,0,0,0];
 if(from+span===until)return new Float64Array(row(from,span));
 const first=span*.75,middle=from+first,last=until-middle;
 if(middle<=from||middle>=until||middle+last!==until)throw new RangeError('Unrepresentable stationary endpoint');
 return new Float64Array([...row(from,first),...row(middle,last)]);
}
