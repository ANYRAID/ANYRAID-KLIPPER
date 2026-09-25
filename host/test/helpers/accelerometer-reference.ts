import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import type {StatsPanel} from '../../src/diagnostics/stats-svg.ts';
import type {Spectrogram} from '../../src/calibration/spectrogram.ts';
type Timing={medianMs:number;p95Ms:number};
interface Manifest {version:number;cpu:string;dataSha256:string;compressedSha256:string;uncompressedBytes:number;compressedBytes:number;reports:{'graph-accelerometer':{reports:{raw:boolean;node:Timing;python:Timing;pngExport:Timing}[]};'spectrogram-plot':{nodePng:Timing;pythonPng:Timing};};}
interface Graph {inputSha256:string;plots:{times:number[];values:number[]}[][];samples:number[];}
export interface SpectrumReference {n:number;rate:number;axis:'all'|'x'|'y'|'z';inputSha256:string;p:number[];f:number[];t:number[];samples:number[];}
interface Data {graphs:{raw:Graph;frequency:Graph};spectra:Record<string,SpectrumReference>;plot:{inputSha256:string;samples:number[]};csv:{inputSha256:string;samples:number[];csv:string};}
export const accelerometerManifest=JSON.parse(readFileSync(new URL('../../contracts/accelerometer-retirement.json',import.meta.url),'utf8')) as Manifest;
export function verifyAccelerationInput(input:string|Uint8Array,expected:string){assert.equal(createHash('sha256').update(input).digest('hex'),expected,'Accelerometer fixture hash changed');}
const compressed=readFileSync(new URL('../../contracts/accelerometer-retirement.json.gz',import.meta.url));verifyAccelerationInput(compressed,accelerometerManifest.compressedSha256);assert.equal(compressed.length,accelerometerManifest.compressedBytes);
const bytes=gunzipSync(compressed,{maxOutputLength:16*1024**2});verifyAccelerationInput(bytes,accelerometerManifest.dataSha256);assert.equal(bytes.length,accelerometerManifest.uncompressedBytes);
export const accelerometerReference=JSON.parse(bytes.toString('utf8')) as Data;
function compare(actual:ArrayLike<number>,expected:number[]):number{assert.equal(actual.length,expected.length);let max=0;for(let i=0;i<actual.length;i++){const error=Math.abs(actual[i]-expected[i]);assert(error<=1e-9+Math.abs(expected[i])*1e-10);max=Math.max(max,error);}return max;}
export function compareAccelerationPlots(panels:StatsPanel[],reference:Graph):number{assert.equal(panels.length,reference.plots.length);let max=0;panels.forEach((p,j)=>{assert.equal(p.plot.curves.length,reference.plots[j].length);p.plot.curves.forEach((c,k)=>{const r=reference.plots[j][k];max=Math.max(max,compare(c.times,r.times),compare(c.values,r.values));});});return max;}
export function compareSpectrogram(data:Spectrogram,reference:SpectrumReference):number{return Math.max(compare(data.power,reference.p),compare(data.frequencies,reference.f),compare(data.times,reference.t));}
export function timing(a:number[]):Timing{a.sort((a,b)=>a-b);return {medianMs:a[Math.floor(a.length/2)],p95Ms:a[Math.ceil(a.length*.95)-1]};}
export function compareSpectrogramCsv(csv:string,data:Spectrogram){
 const {frequencies,times,power,frames}=data,reference=accelerometerReference.csv;verifyAccelerationInput(JSON.stringify({frequencies:Array.from(frequencies),times:Array.from(times),power:Array.from(power)}),reference.inputSha256);
 const own=csv.trimEnd().split('\n'),original=reference.csv.trimEnd().split('\n');assert.equal(own.length,original.length);assert.equal(own[0].split(',')[0],'freq\\t');let maxRoundTripError=0,maxOriginalRounding=0;
 for(let row=0;row<own.length;row++){const a=own[row].split(','),b=original[row].split(',');assert.equal(a.length,b.length);for(let col=row===0?1:0;col<a.length;col++){const expected=row===0?times[col-1]:col===0?frequencies[row-1]:power[(row-1)*frames+col-1];maxRoundTripError=Math.max(maxRoundTripError,Math.abs(Number(a[col])-expected));maxOriginalRounding=Math.max(maxOriginalRounding,Math.abs(Number(b[col])-expected));const limit=row===0?5.1e-7:col===0?.051:Math.abs(expected)*5.1e-7+1e-15;assert(Math.abs(Number(b[col])-expected)<=limit);}}
 assert.equal(maxRoundTripError,0);return {maxRoundTripError,maxOriginalRounding};
}
