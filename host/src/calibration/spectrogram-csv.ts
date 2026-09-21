// GPL-3.0-or-later. Diagnostic matrix export, with round-trip float precision.
import type {Spectrogram} from './spectrogram.ts';
export function spectrogramCsv(data:Spectrogram):string{
 const {frequencies,times,power,frames}=data;
 if(![frequencies,times,power].every(a=>a instanceof Float64Array&&!(a.buffer instanceof SharedArrayBuffer))||!Number.isInteger(frames)||frames<1||times.length!==frames||!frequencies.length||frequencies.length*frames>2000000||power.length!==frequencies.length*frames)throw new RangeError('Invalid spectrogram matrix');
 for(const values of [frequencies,times])for(let i=0;i<values.length;i++)if(!Number.isFinite(values[i])||values[i]<0||(i>0&&values[i]<=values[i-1]))throw new RangeError('Invalid spectrogram coordinates');
 for(let i=0;i<power.length;i++)if(!Number.isFinite(power[i])||power[i]<0)throw new RangeError('Invalid spectrogram power');
 const number=(v:number)=>Object.is(v,-0)?'-0':String(v),lines:string[]=[];let bytes=0;
 const append=(line:string)=>{bytes+=line.length+1;if(bytes>64*1024**2)throw new RangeError('Spectrogram CSV output limit exceeded');lines.push(line);};
 append('freq\\t,'+Array.from(times,number).join(','));
 for(let f=0;f<frequencies.length;f++){const row=new Array<string>(frames+1);row[0]=number(frequencies[f]);for(let t=0;t<frames;t++)row[t+1]=number(power[f*frames+t]);append(row.join(','));}
 return lines.join('\n')+'\n';
}
