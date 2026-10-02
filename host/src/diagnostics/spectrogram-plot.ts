// GPL-3.0-or-later. Offline logarithmic heatmap; numerical matrix stays unchanged.
import sharp from 'sharp';
import type {Spectrogram} from '../calibration/spectrogram.ts';
import {validateSpectrogramMatrix} from '../calibration/spectrogram-csv.ts';
import {writePlotDocument} from './graphstats-file.ts';
const escape=(s:string)=>s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'�').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
const label=(n:number)=>Number(n.toPrecision(4)).toString();
function validate(data:Spectrogram,title:string,maxFrequency:number){
 validateSpectrogramMatrix(data);const {fftSize,sampleRate,frequencies,times,frames}=data;
 if(typeof title!=='string'||title.length>4096||!Number.isFinite(maxFrequency)||maxFrequency<.01||maxFrequency>100000||!Number.isInteger(fftSize)||fftSize<2||fftSize>65536||(fftSize&(fftSize-1))||!Number.isFinite(sampleRate)||sampleRate<=0||sampleRate>131072||frequencies.length!==fftSize/2+1)throw new RangeError('Invalid spectrogram plot');
 for(let f=0;f<frequencies.length;f++)if(frequencies[f]!==f*sampleRate/fftSize)throw new RangeError('Nonuniform spectrogram frequencies');
 for(let t=0;t<frames;t++)if(times[t]!== (fftSize/2+t*fftSize/2)/sampleRate)throw new RangeError('Nonuniform spectrogram times');
 if(!Number.isFinite((times[frames-1]+fftSize/4/sampleRate)))throw new RangeError('Spectrogram time range overflow');
}
export async function renderSpectrogramSvg(data:Spectrogram,title:string,maxFrequency=200):Promise<string>{
 validate(data,title,maxFrequency);const {frequencies,times,power,frames,fftSize,sampleRate}=data,bins=frequencies.length;
 let min=Infinity,max=0;for(let i=0;i<power.length;i++)if(power[i]>0){min=Math.min(min,power[i]);max=Math.max(max,power[i]);}
 const pixels=Buffer.alloc(power.length*3,255),low=Math.log(min),span=Math.log(max)-low;
 // Blue -> green -> yellow. Explicit palette, not a pixel match to Matplotlib viridis.
 for(let f=0;f<bins;f++)for(let t=0;t<frames;t++){const v=power[f*frames+t];if(v===0)continue;const ratio=span>0?(Math.log(v)-low)/span:.5,index=((bins-1-f)*frames+t)*3;
  pixels[index]=Math.round(255*Math.max(0,2*ratio-1));pixels[index+1]=Math.round(200*Math.min(1,2*ratio));pixels[index+2]=Math.round(140*(1-ratio));
 }
 const png=await sharp(pixels,{raw:{width:frames,height:bins,channels:3},limitInputPixels:2000000}).png().toBuffer();
 const left=85,top=65,w=670,h=430,df=sampleRate/fftSize,hop=fftSize/2/sampleRate,xmin=times[0]-hop/2,xmax=times[frames-1]+hop/2,upper=frequencies[bins-1]+df/2;
 const parts=[`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="900" height="600" viewBox="0 0 900 600" role="img"><title>${escape(title)}</title><desc>Logarithmic power; white means zero. Every matrix cell is embedded. Display pixels may combine cells; CSV and JSON retain full precision.</desc><style>text{font-family:DejaVu Sans,sans-serif;font-size:12px;fill:#172033}</style><rect width="900" height="600" fill="white"/><defs><clipPath id="heatmap"><rect x="${left}" y="${top}" width="${w}" height="${h}"/></clipPath><linearGradient id="scale" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="rgb(0,0,140)"/><stop offset=".5" stop-color="rgb(0,200,70)"/><stop offset="1" stop-color="rgb(255,200,0)"/></linearGradient></defs><text x="450" y="30" text-anchor="middle" style="font-size:17px">${escape(Array.from(title).slice(0,85).join(''))}</text><image x="${left}" y="${top+(maxFrequency-upper)/maxFrequency*h}" width="${w}" height="${bins*df/maxFrequency*h}" preserveAspectRatio="none" clip-path="url(#heatmap)" xlink:href="data:image/png;base64,${png.toString('base64')}"/>`];
 for(let i=0;i<=5;i++){const r=i/5;parts.push(`<text x="${left+w*r}" y="520" text-anchor="middle">${label(xmin+(xmax-xmin)*r)}</text><text x="75" y="${top+h*(1-r)+4}" text-anchor="end">${label(maxFrequency*r)}</text>`);}
 parts.push(`<rect x="${left}" y="${top}" width="${w}" height="${h}" fill="none" stroke="#64748b"/><text x="420" y="550" text-anchor="middle">Time (s)</text><text transform="translate(22,280) rotate(-90)" text-anchor="middle">Frequency (Hz)</text>`);
 if(max>0)parts.push(`<rect x="780" y="${top}" width="18" height="${h}" fill="${min===max?'rgb(0,200,70)':'url(#scale)'}"/><text x="806" y="${top+8}">${label(max)}</text><text x="806" y="${top+h}">${label(min)}</text>`);
 parts.push(`<text x="450" y="580" text-anchor="middle">${max>0?'Log power; white = zero':'All power is zero'}</text></svg>`);return parts.join('');
}
export async function writeSpectrogram(data:Spectrogram,title:string,maxFrequency:number,filename:string,signal:AbortSignal):Promise<void>{
 signal.throwIfAborted();validate(data,title,maxFrequency);await writePlotDocument({title,maxFrequency,scale:'log',zero:'white',frames:data.frames,fftSize:data.fftSize,sampleRate:data.sampleRate,frequencies:Array.from(data.frequencies),times:Array.from(data.times),power:Array.from(data.power)},()=>renderSpectrogramSvg(data,title,maxFrequency),filename,signal);
}
