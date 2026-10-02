import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import type {NamedSpectrum} from '../../src/calibration/accelerometer-log.ts';
import type {FitResult} from '../../src/calibration/shaper-fit.ts';
interface Dataset {name:string;frequencies:number[];psd:number[];axes:null|{x:number[];y:number[];z:number[]};}
export interface CalibrationReference {
 version:number;sourceCommit:string;sources:Record<string,string>;python:string;numpy:string;cpu:string;
 cases:Record<string,{inputSha256:string;samples:number[];datasets:Dataset[]}>;
 cli:{inputSha256:string;stdout:string;csv:string;fit:{best:string;shapers:(Omit<FitResult,'frequencies'|'values'>&{frequencies:number[];values:number[]})[]};performance:{recommendation:string;python:{medianMs:number;p95Ms:number}}};
}
export const calibrationReference=JSON.parse(readFileSync(new URL('../../contracts/calibration-retirement.json',import.meta.url),'utf8')) as CalibrationReference;
export function verifyCalibrationInput(text:string,hash:string){assert.equal(createHash('sha256').update(text).digest('hex'),hash,'Calibration fixture bytes changed');}
export function compareCalibrationDatasets(datasets:NamedSpectrum[],expected:Dataset[]):number{
 let maxError=0;assert.equal(datasets.length,expected.length);
 const compare=(a:Float64Array,b:number[])=>{assert.equal(a.length,b.length);a.forEach((v,i)=>{const error=Math.abs(v-b[i]);maxError=Math.max(maxError,error);assert(error<=1e-9+Math.abs(b[i])*1e-10);});};
 datasets.forEach((d,j)=>{const r=expected[j];assert.equal(d.name,r.name);compare(d.frequencies,r.frequencies);compare(d.psd,r.psd);assert.equal(!!d.axes,!!r.axes);if(d.axes&&r.axes)for(const axis of ['x','y','z'] as const)compare(d.axes[axis],r.axes[axis]);});return maxError;
}
