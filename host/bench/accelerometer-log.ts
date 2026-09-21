import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {parseAccelerometerLog,accelerometerDatasets} from '../src/calibration/accelerometer-log.ts';
const python=process.env.PYTHON??'python3',oracle=String.raw`
import sys,types,runpy,time,json
sys.modules['matplotlib']=types.ModuleType('matplotlib')
r=runpy.run_path(sys.argv[1]);samples=[]
for i in range(16):
 start=time.perf_counter();data=r['parse_log'](sys.argv[2]);samples.append((time.perf_counter()-start)*1000)
print(json.dumps(dict(samples=samples,datasets=[dict(name=d.name,frequencies=d.freq_bins.tolist(),psd=d.psd_sum.tolist(),axes=None if d.psd_x is None else dict(x=d.psd_x.tolist(),y=d.psd_y.tolist(),z=d.psd_z.tolist())) for d in data.get_datasets()]),allow_nan=False))
`;
const raw=Array.from({length:8192},(_,i)=>`${i/3200},${3+200*Math.sin(2*Math.PI*43*i/3200)},${100*Math.cos(2*Math.PI*67*i/3200)},${50*Math.sin(2*Math.PI*123*i/3200)}`).join('\n'),rows=Array.from({length:512},(_,i)=>`${i},${i*.3},${i*.2},${i*.1},${i*.6}`).join('\n'),cases={raw,axes:'freq,psd_x,psd_y,psd_z,psd_xyz\n'+rows,normalized:'freq,psd_x,psd_y,psd_z,psd_xyz,shapers:,mzv\n'+rows.split('\n').map(s=>s+',,.2').join('\n'),multi:'freq,"run, A",run B,shapers:,mzv\n'+Array.from({length:512},(_,i)=>`${i},${i*.3},${i*.4},,.5`).join('\n')},dir=mkdtempSync(join(tmpdir(),'accel-log-')),reports=[],stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[Math.floor(a.length/2)],p95Ms:a[Math.ceil(a.length*.95)-1]};};
try{for(const [kind,text] of Object.entries(cases)){const path=join(dir,kind+'.csv');writeFileSync(path,text);const reference=JSON.parse(execFileSync(python,['-c',oracle,fileURLToPath(new URL('../../scripts/calibrate_shaper.py',import.meta.url)),path],{encoding:'utf8',maxBuffer:16*1024**2})),samples:number[]=[];let maxError=0;for(let run=0;run<16;run++){const start=performance.now(),datasets=accelerometerDatasets(parseAccelerometerLog(readFileSync(path,'utf8'),path),true);if(run>=5)samples.push(performance.now()-start);assert.equal(datasets.length,reference.datasets.length);datasets.forEach((d,j)=>{const r=reference.datasets[j];assert.equal(d.name,r.name);const compare=(a:Float64Array,b:number[])=>{assert.equal(a.length,b.length);a.forEach((v,i)=>{const error=Math.abs(v-b[i]);maxError=Math.max(maxError,error);assert.ok(error<=1e-9+Math.abs(b[i])*1e-10);});};compare(d.frequencies,r.frequencies);compare(d.psd,r.psd);if(d.axes)for(const axis of ['x','y','z'] as const)compare(d.axes[axis],r.axes[axis]);});}reports.push({kind,bytes:Buffer.byteLength(text),node:stats(samples),python:stats(reference.samples.slice(5)),maxError});}console.log(JSON.stringify({node:process.version,warmups:5,runs:11,reports,scope:'File read, parsing and calibration preparation; raw input includes Welch FFT, normalized headers bypass normalization. Original Python calibrate_shaper parse_log. Startup/IPC excluded; desktop diagnostic only.'},null,2));}finally{rmSync(dir,{recursive:true,force:true});}
