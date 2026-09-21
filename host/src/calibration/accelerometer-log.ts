// Accelerometer log boundary for graph_accelerometer / calibrate_shaper.
// GPL-3.0-or-later; original scripts by Kevin O'Connor and Dmitry Butyugin.
import {calculateSpectrum} from './spectrum.ts';
import {normalizeShaperDataset,type ShaperDataset} from './shaper-fit.ts';
export interface NamedSpectrum extends ShaperDataset {name:string;normalized:boolean;axes?:{x:Float64Array;y:Float64Array;z:Float64Array};}
export type AccelerometerLog={kind:'raw';name:string;samples:Float64Array}|{kind:'psd';datasets:NamedSpectrum[]};
function csvHeader(line:string):string[]{const result:string[]=[];let field='',quoted=false,closed=false;for(let i=0;i<line.length;i++){const c=line[i];if(quoted){if(c==='"'){if(line[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}else field+=c;}else if(c===','){result.push(field);field='';closed=false;}else if(c==='"'&&!field&&!closed)quoted=true;else{if(closed||c==='"')throw new Error('Malformed CSV header');field+=c;}}if(quoted)throw new Error('Unterminated CSV header');result.push(field);return result;}
function numeric(text:string,missing=false):number{const value=text.trim();if(!value&&missing)return 0;if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value))throw new Error('Invalid accelerometer number');const n=Number(value);if(!Number.isFinite(n))throw new Error('Nonfinite accelerometer number');return n;}
export function parseAccelerometerLog(text:string,name:string):AccelerometerLog{
 if(Buffer.byteLength(text)>64*1024**2)throw new RangeError('Accelerometer text limit exceeded');
 const lines=text.split(/\r\n|\r|\n/).filter(line=>line.trim()&&!line.startsWith('#'));if(!lines.length)throw new Error('No accelerometer data');if(lines.some(line=>line.length>65536))throw new RangeError('Accelerometer line limit exceeded');
 const psd=lines[0].startsWith('freq,'),header=psd?csvHeader(lines.shift()!):undefined,width=header?.length??4;
 if(width>128||!lines.length||lines.length>1000000||lines.length*width>4000000)throw new RangeError('Accelerometer table capacity exceeded');
 const raw=psd?undefined:new Float64Array(lines.length*4),columns=psd?Array.from({length:width},()=>new Float64Array(lines.length)):[];
 for(let i=0;i<lines.length;i++){const fields=lines[i].split('#',1)[0].split(',');if(fields.length!==width)throw new Error('Inconsistent accelerometer column count');for(let j=0;j<width;j++){const value=numeric(fields[j],psd);if(raw)raw[i*4+j]=value;else columns[j][i]=value;}const coordinate=raw?raw[i*4]:columns[0][i],previous=raw?raw[(i-1)*4]:columns[0][i-1];if((psd&&coordinate<0)||(i>0&&coordinate<=previous))throw new Error('Sample coordinates must increase');}
 if(raw)return {kind:'raw',name,samples:raw};
 const marker=header!.indexOf('shapers:'),normalized=marker>=0,axisFormat=header!.slice(0,5).join(',')==='freq,psd_x,psd_y,psd_z,psd_xyz',end=marker<0?width:marker,datasets:NamedSpectrum[]=[];
 if(axisFormat&&end<5)throw new Error('Incomplete axis spectrum');
 const count=axisFormat?1:end-1;if(count<1||count>16)throw new RangeError('Expected 1 to 16 spectrum datasets');
 const checked=(column:number)=>{const values=columns[column];if(values.some(v=>v<0))throw new RangeError('Negative spectral density');return values;};
 if(axisFormat)datasets.push({name,frequencies:columns[0],psd:checked(4),normalized,axes:{x:checked(1),y:checked(2),z:checked(3)}});
 else for(let i=1;i<end;i++){if(!header![i]||header![i].length>1024)throw new Error('Invalid dataset name');datasets.push({name:header![i],frequencies:columns[0].slice(),psd:checked(i),normalized});}
 return {kind:'psd',datasets};
}
/** Synchronous offline bridge. Live hosts must dispatch FFT/fitting to workers. */
export function accelerometerDatasets(log:AccelerometerLog,normalize=false):NamedSpectrum[]{
 let datasets:NamedSpectrum[];
 if(log.kind==='raw'){const spectrum=calculateSpectrum(log.name,log.samples);if(!spectrum)throw new Error('Insufficient accelerometer samples for spectrum');datasets=[{name:log.name,frequencies:spectrum.frequencies,psd:spectrum.sum,axes:{x:spectrum.x,y:spectrum.y,z:spectrum.z},normalized:false}];}else datasets=log.datasets;
 return datasets.map(d=>{if(!normalize||d.normalized)return {...d,frequencies:d.frequencies.slice(),psd:d.psd.slice(),axes:d.axes?{x:d.axes.x.slice(),y:d.axes.y.slice(),z:d.axes.z.slice()}:undefined};const result=normalizeShaperDataset(d),axes=d.axes?Object.fromEntries(Object.entries(d.axes).map(([key,psd])=>[key,normalizeShaperDataset({frequencies:d.frequencies,psd}).psd])) as NamedSpectrum['axes']:undefined;return {...result,name:d.name,normalized:true,axes};});
}
