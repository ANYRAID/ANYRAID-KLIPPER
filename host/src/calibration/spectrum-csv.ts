// Calibration CSV layout based on shaper_calibrate.py, GPL-3.0-or-later.
import type {NamedSpectrum} from './accelerometer-log.ts';
const quote=(name:string)=>/[",]/.test(name)?'"'+name.replaceAll('"','""')+'"':name;
/** Preserve round-trip binary64 precision instead of the legacy %.1f/%.3e loss. */
export function spectrumCsv(datasets:readonly NamedSpectrum[],maxFrequency=200):string{
 if(!datasets.length||datasets.length>16||!Number.isFinite(maxFrequency)||maxFrequency<=0||maxFrequency>100000)throw new RangeError('Invalid spectrum CSV options');
 let cells=0;for(const d of datasets){const n=d.frequencies.length;if(!n||n>1000000||d.psd.length!==n||d.axes&&Object.values(d.axes).some(a=>a.length!==n))throw new RangeError('Invalid spectrum dimensions');if(d.normalized!==datasets[0].normalized)throw new Error('Cannot mix normalized and unnormalized spectra');if(!d.name||d.name.length>1024||/[\r\n\0]/.test(d.name)||d.name==='shapers:')throw new Error('Invalid CSV dataset name');cells+=n*(d.axes?5:2);if(cells>4000000)throw new RangeError('Spectrum CSV input limit exceeded');const arrays=[d.psd,...(d.axes?Object.values(d.axes):[])];for(let i=0;i<n;i++){const f=d.frequencies[i];if(!Number.isFinite(f)||f<0||i&&f<=d.frequencies[i-1])throw new Error('Frequency bins must increase');for(const a of arrays)if(!Number.isFinite(a[i])||a[i]<0)throw new Error('Invalid spectral density');}}
 const single=datasets.length===1,axes=single&&datasets[0].axes,headers=axes?['psd_x','psd_y','psd_z','psd_xyz']:datasets.map(d=>d.name);
 if(!axes&&headers.slice(0,4).join(',')==='psd_x,psd_y,psd_z,psd_xyz')throw new Error('Dataset names collide with axis CSV layout');
 const normalized=datasets[0].normalized,lines=['freq,'+headers.map(quote).join(',')+(normalized?',shapers:':'')],positions=datasets.map(()=>0);
 let frequencies:Float64Array;
 if(single)frequencies=datasets[0].frequencies;
 else{const start=Math.min(maxFrequency,...datasets.map(d=>d.frequencies[0])),count=Math.ceil((maxFrequency-start)/.2);if(count>100000)throw new RangeError('Spectrum CSV grid limit exceeded');const step=(start+.2)-start;frequencies=Float64Array.from({length:count},(_,i)=>start+i*step);}
 let rows=0;for(const f of frequencies){if(f>=maxFrequency)break;if(++rows>100000)throw new RangeError('Spectrum CSV row limit exceeded');const values=axes?[axes.x[rows-1],axes.y[rows-1],axes.z[rows-1],datasets[0].psd[rows-1]]:datasets.map((d,k)=>{if(single)return d.psd[rows-1];let j=positions[k];while(j+1<d.frequencies.length&&d.frequencies[j+1]<f)j++;positions[k]=j;if(f<=d.frequencies[0])return d.psd[0];if(j+1===d.frequencies.length)return d.psd[j];return d.psd[j]+(f-d.frequencies[j])*(d.psd[j+1]-d.psd[j])/(d.frequencies[j+1]-d.frequencies[j]);});if(values.some(v=>!Number.isFinite(v)))throw new Error('Spectrum interpolation overflow');lines.push([f,...values].map(v=>Object.is(v,-0)?'-0':String(v)).join(',')+(normalized?',':''));}
 if(!rows)throw new Error('No frequency bins in CSV range');const output=lines.join('\n')+'\n';if(Buffer.byteLength(output)>64*1024**2)throw new RangeError('Spectrum CSV output limit exceeded');return output;
}
