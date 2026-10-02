import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {spectrumCsv} from '../src/calibration/spectrum-csv.ts';
import {parseAccelerometerLog,accelerometerDatasets,type NamedSpectrum} from '../src/calibration/accelerometer-log.ts';
const datasets:NamedSpectrum[]=Array.from({length:8},(_,i)=>({name:'sample'+i,normalized:false,frequencies:Float64Array.from({length:1024},(_,j)=>j*.25+i*.01),psd:Float64Array.from({length:1024},(_,j)=>.01+(i+1)*Math.exp(-(((j*.25-40-i)/7)**2)))}));
const source=String.raw`
import sys,json,time,io,numpy as np
sys.path.insert(0,sys.argv[1]);from extras import shaper_calibrate as m
request=json.load(sys.stdin);datasets=[]
for d in request:
 c=m.CalibrationData(d['name'],np.array(d['frequencies']),np.array(d['psd']),None,None,None);c.set_numpy(np);datasets.append(c)
for c in datasets[1:]:datasets[0].add_data(c)
class Output(io.StringIO):
 def close(self):pass
latest=[]
def opened(*a,**kw):
 latest[:]=[Output()];return latest[0]
m.open=opened;helper=m.ShaperCalibrate(None);samples=[]
for i in range(16):
 start=time.perf_counter();helper.save_calibration_data('unused',datasets[0]);samples.append((time.perf_counter()-start)*1000)
f=np.arange(0,200,.2)
print(json.dumps(dict(samples=samples,frequencies=f.tolist(),values=[np.interp(f,d.freq_bins,d.psd_sum).tolist() for d in datasets],csv=latest[0].getvalue())))
`;
const reference=JSON.parse(execFileSync(process.env.PYTHON??'python3',['-c',source,fileURLToPath(new URL('../../klippy',import.meta.url))],{input:JSON.stringify(datasets.map(d=>({...d,frequencies:Array.from(d.frequencies),psd:Array.from(d.psd)}))),encoding:'utf8',maxBuffer:8*1024**2})),samples:number[]=[];let maxError=0,bytes=0;for(let run=0;run<16;run++){const at=performance.now(),csv=spectrumCsv(datasets);if(run>=5)samples.push(performance.now()-at);bytes=Buffer.byteLength(csv);const parsed=accelerometerDatasets(parseAccelerometerLog(csv,'generated'));parsed.forEach((d,k)=>{assert.equal(d.psd.length,reference.values[k].length);d.psd.forEach((v,i)=>{maxError=Math.max(maxError,Math.abs(v-reference.values[k][i]));assert.ok(Math.abs(d.frequencies[i]-reference.frequencies[i])<=1e-12);});});}assert.ok(maxError<=1e-12);const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[Math.floor(a.length/2)],p95Ms:a[Math.ceil(a.length*.95)-1]};};console.log(JSON.stringify({node:process.version,datasets:8,inputBins:1024,outputBins:1000,warmups:5,runs:11,nodeSerialize:stats(samples),pythonSerialize:stats(reference.samples.slice(5)),maxInterpolationError:maxError,nodeBytes:bytes,pythonBytes:Buffer.byteLength(reference.csv),scope:'Validate/interpolate/serialize in memory. Original Python serializer writes StringIO and rounds to %.1f/%.3e; Node deliberately preserves full double precision. Numerical oracle is NumPy interp before text rounding. Disk, startup/IPC excluded.'},null,2));
