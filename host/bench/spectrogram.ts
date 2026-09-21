import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {calculateSpectrogram} from '../src/calibration/spectrogram.ts';
const source=String.raw`
import sys,json,time,runpy,numpy as np,matplotlib,matplotlib.mlab
fn=runpy.run_path(sys.argv[1])['calc_specgram']
a=np.fromfile(sys.argv[2],dtype='<f8').reshape(-1,4);samples=[]
for i in range(16):
 start=time.perf_counter();p,f,t=fn(a,sys.argv[3]);samples.append((time.perf_counter()-start)*1000)
print(json.dumps(dict(p=p.ravel().tolist(),f=f.tolist(),t=t.tolist(),samples=samples[5:],python=sys.version.split()[0],numpy=np.__version__,matplotlib=matplotlib.__version__)))
`;
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[Math.floor(a.length/2)],p95Ms:a[Math.ceil(a.length*.95)-1]};};
const dir=mkdtempSync(join(tmpdir(),'spectrogram-bench-'));
try{for(const [n,rate,axis] of [[64,1000,'all'],[512,1000,'x'],[8192,3200,'all'],[65536,3200,'all'],[4096,997,'y'],[4096,1000,'z']] as const){
 const raw=new Float64Array(n*4);for(let i=0;i<n;i++){raw[i*4]=17+i/rate;raw[i*4+1]=100*Math.sin(2*Math.PI*43*i/rate)+3;raw[i*4+2]=40*Math.cos(2*Math.PI*67*i/rate)-7;raw[i*4+3]=i%2?2:-2;}
 const bytes=Buffer.alloc(raw.byteLength);raw.forEach((v,i)=>bytes.writeDoubleLE(v,i*8));const path=join(dir,'samples.bin');writeFileSync(path,bytes);
 const ref=JSON.parse(execFileSync(process.env.PYTHON??'python3',['-c',source,fileURLToPath(new URL('../../scripts/graph_accelerometer.py',import.meta.url)),path,axis],{encoding:'utf8',maxBuffer:32*1024**2}));
 const samples:number[]=[];let result=calculateSpectrogram(raw,axis);for(let i=0;i<16;i++){const at=performance.now();result=calculateSpectrogram(raw,axis);if(i>=5)samples.push(performance.now()-at);}
 let maxAbsoluteError=0,maxScaledError=0;for(const [values,expected] of [[result.power,ref.p],[result.frequencies,ref.f],[result.times,ref.t]] as [Float64Array,number[]][]){assert.equal(values.length,expected.length);values.forEach((v,i)=>{const error=Math.abs(v-expected[i]);maxAbsoluteError=Math.max(maxAbsoluteError,error);maxScaledError=Math.max(maxScaledError,error/(1+Math.abs(expected[i])));assert.ok(error<=1e-9+Math.abs(expected[i])*1e-10,`n=${n} axis=${axis} index=${i} ${v} != ${expected[i]}`);});}
 console.log(JSON.stringify({node:process.version,python:ref.python,numpy:ref.numpy,matplotlib:ref.matplotlib,n,rate,axis,fftSize:result.fftSize,frames:result.frames,warmups:5,runs:11,nodeCompute:stats(samples),pythonCompute:stats(ref.samples),maxAbsoluteError,maxScaledError,scope:'Original calc_specgram with actual matplotlib.mlab; parsed Float64 input; allocation, validation and FFT included, file IO/startup/IPC excluded.'}));
}}finally{rmSync(dir,{recursive:true,force:true});}
