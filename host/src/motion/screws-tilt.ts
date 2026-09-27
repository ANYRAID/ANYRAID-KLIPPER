// Bed screw adjustment from klippy/extras/screws_tilt_adjust.py. GPL-3.0-or-later.
export const screwThreads=['CW-M3','CCW-M3','CW-M4','CCW-M4','CW-M5','CCW-M5','CW-M6','CCW-M6'] as const;
export type ScrewThread=typeof screwThreads[number];
export type ScrewDirection='CW'|'CCW';
/** Python round(x, 0), for nonnegative bounded fractional-turn minutes. */
function roundMinutes(value:number){const low=Math.floor(value),fraction=value-low;return fraction===.5?low+(low%2):Math.round(value);}
export function calculateScrewTilt(heights:readonly number[],thread:ScrewThread,direction?:ScrewDirection,maximumDeviation?:number){
 const index=screwThreads.indexOf(thread);
 if(index<0||heights.length<3||heights.length>99||!heights.every(Number.isFinite)||direction!==undefined&&direction!=='CW'&&direction!=='CCW'||maximumDeviation!==undefined&&(!Number.isFinite(maximumDeviation)||maximumDeviation<0))throw new RangeError('Invalid screw tilt samples or settings');
 const clockwise=index%2===0,pitch=[.5,.7,.8,1][Math.floor(index/2)];let base=0;
 if(direction){const maximum=clockwise&&direction==='CW'||!clockwise&&direction==='CCW';for(let i=1;i<heights.length;i++)if(maximum?heights[i]>heights[base]:heights[i]<heights[base])base=i;}
 let deviation=0;
 const results=heights.map((z,i)=>{
  const difference=heights[base]-z;if(!Number.isFinite(difference))throw new RangeError('Screw height difference overflow');
  deviation=Math.max(deviation,Math.abs(difference));const turns=Math.abs(difference)<.001?0:difference/pitch;
  if(!Number.isFinite(turns)||Math.abs(turns)>Number.MAX_SAFE_INTEGER/60)throw new RangeError('Screw adjustment is unrepresentable');
  const sign:ScrewDirection=clockwise?(turns>=0?'CW':'CCW'):(turns>=0?'CCW':'CW'),magnitude=Math.abs(turns),full=Math.trunc(magnitude),minutes=roundMinutes((magnitude-full)*60);
  return {z,sign,adjust:String(full).padStart(2,'0')+':'+String(minutes).padStart(2,'0'),is_base:i===base,turns:magnitude};
 });
 // Unlike the legacy truthiness check, an explicit zero tolerance means zero.
 return {base,deviation,error:maximumDeviation!==undefined&&deviation>maximumDeviation,results};
}
