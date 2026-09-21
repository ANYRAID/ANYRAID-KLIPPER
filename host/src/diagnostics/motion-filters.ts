// Offline experimental filters from scripts/graph_motion.py.
// Kevin O'Connor / Dmitry Butyugin; GPL-3.0-or-later.
export type MotionFilter='average'|'smooth'|'weighted'|'weighted2'|'weighted3'|'weighted4'|'spring_raw'|'spring_double_weighted';
export const motionFilters:readonly MotionFilter[]=Object.freeze(['average','smooth','weighted','weighted2','weighted3','weighted4','spring_raw','spring_double_weighted']);
const margin=500,inv=10000;
function validate(data:readonly number[]):void{if(data.length>100000)throw new RangeError('Invalid diagnostic sample array');for(const v of data)if(!Number.isFinite(v))throw new RangeError('Invalid diagnostic sample array');}
function offset(time:number,factor:number):number{if(!Number.isFinite(time)||time<=0)throw new RangeError('Expected positive finite smoothing time');const result=Math.trunc(time*factor*inv+.5);if(result<1||result>margin)throw new RangeError('Smoothing exceeds sample resolution or fixed margin');return result;}
/** Uses the original 0.1 ms grid and fixed 50 ms zero margins. */
export function filterMotion(data:readonly number[],filter:MotionFilter,smoothTime=(2/3)/40):number[]{
 validate(data);if(!motionFilters.includes(filter))throw new RangeError('Unknown motion filter');
 const out=Array<number>(data.length).fill(0);
 if(filter==='spring_raw'||filter==='spring_double_weighted'){
  const n=filter==='spring_raw'?1:offset(smoothTime,.25),sa=(inv/(n*40*2*Math.PI))**2,ra=2*.1*Math.sqrt(sa);
  for(let i=margin;i<data.length-margin;i++)out[i]=data[i]+sa*(data[i-n]-2*data[i]+data[i+n])+ra*(data[i+1]-data[i]);
  if(out.some(v=>!Number.isFinite(v)))throw new RangeError('Spring filter overflow');
  return filter==='spring_raw'?out:filterMotion(out,'weighted',smoothTime*.5);
 }
 const n=offset(smoothTime,.5);if(filter!=='average'&&Math.max(0,data.length-2*margin)*2*n>50000000)throw new RangeError('Diagnostic filter work limit exceeded');
 const weight=filter==='smooth'?1/(2*n-1):filter==='weighted'?1/n**2:filter==='weighted2'?.75/n**3:filter==='weighted3'?1/n**4:15/(16*n**5);
 for(let i=margin;i<data.length-margin;i++){
  if(filter==='average'){out[i]=.5*(data[i-n]+data[i+n]);continue;}
  let high=0,low=0;const first=filter==='smooth'?i-n+1:i-n;
  for(let j=first;j<i+n;j++){const d=j-i,abs=Math.abs(d),value=filter==='smooth'?data[j]:filter==='weighted'?data[j]*(n-abs):filter==='weighted2'?data[j]*(n**2-d**2):filter==='weighted3'?data[j]*(n-abs)**2*(2*abs+n):data[j]*(n**2-d**2)**2,next=high+value;low+=Math.abs(high)>=Math.abs(value)?(high-next)+value:(value-next)+high;high=next;}
  out[i]=(high+low)*weight;
 }
 if(out.some(v=>!Number.isFinite(v)))throw new RangeError('Motion filter overflow');return out;
}
