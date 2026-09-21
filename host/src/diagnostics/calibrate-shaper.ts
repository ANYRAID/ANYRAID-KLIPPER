// GPL-3.0-or-later. Offline calibration presentation; never applies printer settings.
import type {NamedSpectrum} from '../calibration/accelerometer-log.ts';
import type {ShaperFit} from '../calibration/shaper-fit.ts';
import {spectrumCsv} from '../calibration/spectrum-csv.ts';
import {accelerometerPlots} from './graph-accelerometer.ts';
import type {StatsPanel} from './stats-svg.ts';
function interp(f:number,x:Float64Array,y:Float64Array):number{if(f<=x[0])return y[0];if(f>=x[x.length-1])return y[y.length-1];let lo=0,hi=x.length-1;while(hi-lo>1){const mid=(lo+hi)>>>1;if(x[mid]<f)lo=mid;else hi=mid;}return y[lo]+(f-x[lo])*(y[hi]-y[lo])/(x[hi]-x[lo]);}
export function calibrationCsv(datasets:NamedSpectrum[],fit:ShaperFit,maxFrequency=200):string{
 if(datasets.some(d=>!d.normalized))throw new Error('Calibration CSV requires normalized spectra');const lines=spectrumCsv(datasets,maxFrequency).trimEnd().split('\n');lines[0]+=','+fit.shapers.map(s=>'"'+(s.name+'('+s.frequency.toFixed(1)+')').replaceAll('"','""')+'"').join(',');
 for(let i=1;i<lines.length;i++){const f=Number(lines[i].slice(0,lines[i].indexOf(',')));lines[i]+=','+fit.shapers.map(s=>interp(f,s.frequencies,s.values)).join(',');}
 const result=lines.join('\n')+'\n';if(Buffer.byteLength(result)>64*1024**2)throw new RangeError('Calibration CSV output limit exceeded');return result;
}
export function calibrationPlot(datasets:NamedSpectrum[],fit:ShaperFit,maxFrequency:number):StatsPanel{
 const best=fit.best,max=Math.min(maxFrequency,best.frequencies.at(-1)!),panel=accelerometerPlots([{kind:'psd',datasets}],{maxFrequency:max})[0];panel.plot.title=`Recommended shaper: ${best.name.toUpperCase()} @ ${best.frequency.toFixed(1)} Hz`;panel.plot.axes=['Normalized power spectral density','Shaper vibration reduction (ratio)'];
 const after=new Array<number>(best.frequencies.length).fill(0);
 for(const d of datasets){const end=d.frequencies.findIndex(f=>f>max),n=end<0?d.frequencies.length:end;if(!n)throw new RangeError('No plot frequencies');for(let i=0;i<after.length;i++)after[i]=Math.max(after[i],interp(best.frequencies[i],d.frequencies.subarray(0,n),d.psd.subarray(0,n)));}
 for(let i=0;i<after.length;i++)after[i]*=best.values[i];
 panel.plot.curves.push({label:'After shaper',axis:0,style:'line',times:Array.from(best.frequencies),values:after});
 for(const s of fit.shapers)panel.plot.curves.push({label:`${s.name.toUpperCase()} ${s.frequency.toFixed(1)}Hz vibr=${(100*s.vibrations).toFixed(1)}% sm=${s.smoothing.toFixed(3)} accel<=${s.maxAcceleration.toFixed(0)}`,axis:1,style:'line',times:Array.from(s.frequencies),values:Array.from(s.values)});
 // Respect the display bound for all curves, unlike retaining off-screen points.
 for(const curve of panel.plot.curves){const n=curve.times.findIndex(f=>f>max);if(n>=0){curve.times.length=n;curve.values.length=n;}}
 if(panel.plot.curves.reduce((n,c)=>n+c.times.length,0)>500000)throw new RangeError('Calibration plot point limit exceeded');return panel;
}
