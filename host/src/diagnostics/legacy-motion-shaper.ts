// Fixed legacy graph_motion.py definitions, not production shaper_defs.
// Kevin O'Connor / Dmitry Butyugin; GPL-3.0-or-later.
export const legacyMotionShapers=Object.freeze(['zv','zvd','mzv','ei','2hump_ei','3hump_ei'] as const);
export type LegacyMotionShaper=typeof legacyMotionShapers[number];
function sum(values:readonly number[]):number{let high=0,low=0;for(const value of values){const next=high+value;low+=Math.abs(high)>=Math.abs(value)?(high-next)+value:(value-next)+high;high=next;}return high+low;}
export function legacyMotionPulses(name:LegacyMotionShaper):{amplitudes:number[];times:number[]}{
 if(!legacyMotionShapers.includes(name))throw new RangeError('Unknown legacy diagnostic shaper');
 const df=Math.sqrt(1-.1**2),k=Math.exp(-.1*Math.PI/df),period=1/(40*df),v=.05;let amplitudes:number[],times:number[];
 if(name==='zv'){amplitudes=[1,k];times=[0,.5*period];}
 else if(name==='zvd'){amplitudes=[1,2*k,k**2];times=[0,.5*period,period];}
 else if(name==='mzv'){const km=Math.exp(-.75*.1*Math.PI/df),a1=1-1/Math.sqrt(2);amplitudes=[a1,(Math.sqrt(2)-1)*km,a1*km*km];times=[0,.375*period,.75*period];}
 else if(name==='ei'){const a1=.25*(1+v);amplitudes=[a1,.5*(1-v)*k,a1*k*k];times=[0,.5*period,period];}
 else if(name==='2hump_ei'){const v2=v**2,x=(v2*(Math.sqrt(1-v2)+1))**(1/3),a1=(3*x*x+2*x+3*v2)/(16*x),a2=(.5-a1)*k;amplitudes=[a1,a2,a2*k,a1*k*k*k];times=[0,.5*period,period,1.5*period];}
 else{const k2=k*k,a1=.0625*(1+3*v+2*Math.sqrt(2*(v+1)*v)),a2=.25*(1-v)*k;amplitudes=[a1,a2,(.5*(1+v)-2*a1)*k2,a2*k2,a1*k2*k2];times=[0,.5*period,period,1.5*period,2*period];}
 return {amplitudes,times};
}
export function applyLegacyMotionShaper(input:readonly number[],name:LegacyMotionShaper='ei'):number[]{
 if(input.length>100000)throw new RangeError('Diagnostic sample limit exceeded');for(const value of input)if(!Number.isFinite(value))throw new RangeError('Nonfinite diagnostic position');
 const {amplitudes:a,times}=legacyMotionPulses(name),shift=sum(a.map((v,i)=>v*times[i]))/sum(a),offsets=times.map(t=>Math.trunc(-(t-shift)*10000+.5)),gain=1/sum(a),out=Array<number>(input.length).fill(0);
 if(offsets.some(n=>Math.abs(n)>500))throw new RangeError('Legacy pulse exceeds fixed diagnostic margin');
 for(let i=500;i<input.length-500;i++){const value=sum(a.map((v,j)=>input[i+offsets[j]]*v))*gain;if(!Number.isFinite(value))throw new RangeError('Legacy diagnostic shaper overflow');out[i]=value;}return out;
}
