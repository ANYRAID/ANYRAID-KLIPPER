// Input shaper diagnostic simulation, GPL-3.0-or-later.
// Based on scripts/graph_shaper.py, Kevin O'Connor and Dmitry Butyugin (2020).
import {inputShaper,parseShaperName} from '../motion/shaper.ts';
import {shaperResponse} from '../calibration/shaper.ts';
import type {StatsPlot} from './graphstats.ts';
export interface ShaperSimulationOptions {shaper?:string;frequency?:number;damping?:number;testDamping?:readonly number[];systemFrequency?:number;systemDamping?:number;}
export interface ShaperSimulation {frequency:StatsPlot;step:StatsPlot;range:readonly [number,number];}
function sum(values:readonly number[]):number{let high=0,low=0;for(const value of values){const next=high+value;low+=Math.abs(high)>=Math.abs(value)?(high-next)+value:(value-next)+high;high=next;}return high+low;}
function damping(value:number):void{if(!Number.isFinite(value)||value<0||value>=1)throw new RangeError('Damping must be finite in [0,1)');}
function frequency(value:number):void{if(!Number.isFinite(value)||value<.01||value>10000)throw new RangeError('Diagnostic frequency must be in [0.01,10000] Hz');}
function bisect(fn:(x:number)=>number,left:number,right:number):number{const sign=(v:number)=>v<0||Object.is(v,-0)?-1:1,lhs=sign(fn(left));while(right-left>1e-8){const mid=.5*(left+right);if(mid===left||mid===right)break;if(sign(fn(mid))===lhs)left=mid;else right=mid;}return .5*(left+right);}
/** Offline curves only. Fixed sample spacing matches the original diagnostic. */
export function simulateShaper(options:ShaperSimulationOptions={}):ShaperSimulation{
 const name=options.shaper??'mzv',hz=options.frequency??50,dr=options.damping??.1,tests=options.testDamping??[.075,.1,.15],systemHz=options.systemFrequency??60,systemDr=options.systemDamping??.15;
 frequency(hz);frequency(systemHz);damping(dr);damping(systemDr);if(!tests.length||tests.length>16)throw new RangeError('Expected 1 to 16 test damping ratios');tests.forEach(damping);
 const parsed=parseShaperName(name.toLowerCase()),shaper=inputShaper(parsed.name,hz,dr,parsed.options),a=shaper.amplitudes,inv=1/sum(a),shift=sum(a.map((v,i)=>v*shaper.times[i]))*inv,t=shaper.times.map(v=>v-shift);
 // Frequency magnitude is invariant to a common pulse time shift. Reuse the
 // validated calibration kernel with its nonnegative-time input contract.
 const evaluate=(f:number)=>shaperResponse(shaper,tests[0],Float64Array.of(f))[0]-.25;
 const left=bisect(evaluate,0,hz),right=bisect(evaluate,hz,2.4*hz),freqs:number[]=[];
 if(Math.ceil((right-left)/.01)+1>100000)throw new RangeError('Frequency plot point limit exceeded');
 for(let f=left;f<=right;f+=.01)freqs.push(f);
 const frequencyPlot:StatsPlot={title:`Vibration response: ${name}, ${hz} Hz, damping ${dr}`,axes:['Remaining vibrations, ratio'],curves:tests.map(d=>({label:`damping ratio = ${d.toFixed(3)}`,axis:0,style:'line',times:[...freqs],values:Array.from(shaperResponse(shaper,d,Float64Array.from(freqs)))}))};
 const omega=2*Math.PI*systemHz,decay=systemDr*omega,omegaD=omega*Math.sqrt(1-systemDr**2),phase=Math.acos(systemDr),start=t[0]-.5/hz,end=t.at(-1)!+1.5/systemHz,dt=.01/hz;
 if(Math.ceil((end-start)/dt)+1>100000)throw new RangeError('Step plot point limit exceeded');
 const step:StatsPlot={title:`Unit step: resonance ${systemHz} Hz, damping ${systemDr}`,axes:['Amplitude'],curves:['step','shaper commanded','system response'].map(label=>({label,axis:0,style:'line',times:[],values:[]}))};
 for(let time=start;time<=end;time+=dt){let commanded=0,response=0;for(let i=0;i<t.length;i++){if(time<t[i])continue;commanded+=a[i];const elapsed=time-t[i];response+=a[i]*(1-Math.exp(-decay*elapsed)*Math.sin(omegaD*elapsed+phase)/Math.sin(phase));}const values=[time>=0?1:0,commanded*inv,response*inv];values.forEach((v,i)=>{if(!Number.isFinite(v))throw new RangeError('Nonfinite step response');step.curves[i].times.push(time);step.curves[i].values.push(v);});}
 return {frequency:frequencyPlot,step,range:[left,right]};
}
