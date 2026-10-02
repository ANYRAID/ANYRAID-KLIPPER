// GPL-3.0-or-later. Shared norm for Klipper motion planning and mesh splitting.
// CPython 3.12+ sum() compensates rounding. Near-straight junctions amplify
// even a one-ulp norm difference, so retain its high/low accumulation here.
export function spatialDistance(axes:readonly number[]):number {
  let high=0,low=0;
  for(let i=0;i<3;i++) {
    const value=axes[i]*axes[i],total=high+value;
    low+=Math.abs(high)>=Math.abs(value)?(high-total)+value:(value-total)+high;
    high=total;
  }
  return Math.sqrt(high+low);
}
