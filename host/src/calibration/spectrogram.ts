// graph_accelerometer.py / matplotlib.mlab.specgram-compatible diagnostics.
// GPL-3.0-or-later. Independent offline FFT work, not a live motion task.
import FFT from 'fft.js';
import {kaiserWindow} from './spectrum.ts';
export interface Spectrogram {frequencies:Float64Array;times:Float64Array;power:Float64Array;frames:number;fftSize:number;sampleRate:number;}
// Bounded to the 16 supported powers of two; scratch arrays never escape.
const plans=new Map<number,{window:Float64Array;scale:number;fft:FFT;input:Float64Array;output:Float64Array}>();
function getPlan(n:number){const cached=plans.get(n);if(cached)return cached;const window=kaiserWindow(n);let sum=0;for(let i=0;i<n;i++)sum+=window[i];const plan={window,scale:1/sum**2,fft:new FFT(n),input:new Float64Array(n),output:new Float64Array(2*n)};plans.set(n,plan);return plan;}
/** Power is frequency-major: power[frequencyIndex * frames + timeIndex]. */
export function calculateSpectrogram(raw:Float64Array,axis:'all'|'x'|'y'|'z'='all'):Spectrogram{
 if(!(raw instanceof Float64Array)||raw.buffer instanceof SharedArrayBuffer||raw.length%4||raw.length<8||raw.length>16000000||!['all','x','y','z'].includes(axis))throw new RangeError('Invalid spectrogram input');
 for(let i=0;i<raw.length;i++)if(!Number.isFinite(raw[i]))throw new RangeError('Nonfinite spectrogram sample');const n=raw.length/4;for(let i=1;i<n;i++)if(raw[i*4]<=raw[(i-1)*4])throw new RangeError('Spectrogram timestamps must increase');
 const sampleRate=n/(raw[(n-1)*4]-raw[0]),base=Math.trunc(.5*sampleRate-1),fftSize=2**(base===0?0:Math.floor(Math.log2(Math.abs(base)))+1);
 if(!Number.isFinite(sampleRate)||sampleRate<=0||fftSize<2||fftSize>65536)throw new RangeError('Unsupported spectrogram sampling frequency');
 const padded=Math.max(n,fftSize),hop=fftSize/2,frames=Math.floor((padded-fftSize)/hop)+1,bins=fftSize/2+1;if(frames*bins>2000000)throw new RangeError('Spectrogram cell limit exceeded');
 const {window,scale,fft,input,output}=getPlan(fftSize),power=new Float64Array(frames*bins),channels=axis==='all'?[1,2,3]:[{x:1,y:2,z:3}[axis]];
 for(const channel of channels)for(let frame=0;frame<frames;frame++){const offset=frame*hop,available=Math.min(fftSize,n-offset);let mean=0;for(let i=0;i<available;i++)mean+=raw[(offset+i)*4+channel];mean/=fftSize;
  for(let i=0;i<available;i++)input[i]=(raw[(offset+i)*4+channel]-mean)*window[i];for(let i=available;i<fftSize;i++)input[i]=-mean*window[i];fft.realTransform(output,input);
  for(let f=0;f<bins;f++)power[f*frames+frame]+=(output[2*f]**2+output[2*f+1]**2)*(f===0||f===bins-1?1:2)*scale;
 }
 if(!power.every(Number.isFinite))throw new RangeError('Spectrogram power overflow');return {frequencies:Float64Array.from({length:bins},(_,i)=>i*sampleRate/fftSize),times:Float64Array.from({length:frames},(_,i)=>(fftSize/2+i*hop)/sampleRate),power,frames,fftSize,sampleRate};
}
