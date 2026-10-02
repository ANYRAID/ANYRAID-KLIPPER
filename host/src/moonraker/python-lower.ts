import data from '../../contracts/unicode-lower-15.json' with {type:'json'};
const mapping=new Map(data.lower as [number,string][]),ranges=data.context;
function context(cp:number):number{
 let low=0,high=ranges.length-1;
 while(low<=high){const middle=(low+high)>>>1,range=ranges[middle];if(cp<range[0])high=middle-1;else if(cp>range[1])low=middle+1;else return range[2];}return 0;
}
/** Locale-independent Unicode 15 lowercase, including contextual Final_Sigma.
 * Pinned to the Python 3.12 baseline rather than Node's changing Unicode data. */
export function pythonLower(value:string):string{
 const points=Array.from(value,char=>char.codePointAt(0)!);let previousCased=false,result='';
 for(let i=0;i<points.length;i++){
  const cp=points[i],kind=context(cp);
  if(cp===0x3a3&&previousCased){let next=i+1;while(next<points.length&&context(points[next])===2)next++;result+=next<points.length&&context(points[next])===1?'σ':'ς';}
  else result+=mapping.get(cp)??String.fromCodePoint(cp);
  if(kind!==2)previousCased=kind===1;
 }return result;
}
