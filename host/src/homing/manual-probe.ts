// Manual Z search from klippy/extras/manual_probe.py; GPL-3.0-or-later.
export type ManualProbeAdjustment=number|'bisect_up'|'bisect_down'|'previous_up'|'previous_down';
export function manualProbeBounds(position:number,history:readonly number[]){
 let lower:number|null=null,upper:number|null=null;
 for(const p of history){if(p<position&&(lower===null||p>lower))lower=p;if(p>position&&(upper===null||p<upper))upper=p;}
 return {lower,upper};
}
/** Numeric step is relative to resolved motor position, not last requested Z. */
export function planManualProbe(position:number,history:readonly number[],adjustment:ManualProbeAdjustment){
 if(!Number.isFinite(position)||history.length>512||!history.every(Number.isFinite))throw new RangeError('Invalid manual probe history');
 const past=[...new Set([...history,position])].sort((a,b)=>a-b);if(past.length>512)throw new RangeError('Manual probe step budget exceeded');
 let target:number;
 if(typeof adjustment==='number'){if(!Number.isFinite(adjustment)||adjustment===0||Math.abs(adjustment)>5)throw new RangeError('Manual Z step must be nonzero and at most 5 mm');target=position+adjustment;}
 else{
  if(!['bisect_up','bisect_down','previous_up','previous_down'].includes(adjustment))throw new RangeError('Invalid manual search action');
  const up=adjustment.endsWith('_up'),bounds=manualProbeBounds(position,past);let bound=(up?bounds.upper:bounds.lower)??(up?9999999999999.9:-9999999999999.9);
  if(adjustment.startsWith('bisect_'))bound=(bound+position)/2;
  target=up?Math.min(bound,position+.2):Math.max(bound,position-.2);
 }
 const bob=target+.5;if(!Number.isFinite(target)||!Number.isFinite(bob)||bob<=target||target===position)throw new RangeError('Unrepresentable manual probe adjustment');
 return {target,bob,history:past};
}
