import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {calculateSpectrogram} from '../src/calibration/spectrogram.ts';
import {writeSpectrogram} from '../src/diagnostics/spectrogram-plot.ts';
const dir=await mkdtemp(join(tmpdir(),'spectrogram-render-')),raw=new Float64Array(8192*4);for(let i=0;i<8192;i++){const t=i/1000;raw[i*4]=t;raw[i*4+1]=100*Math.sin(2*Math.PI*(20*t+5*t*t));raw[i*4+2]=30*Math.sin(2*Math.PI*120*t);}
const source=String.raw`
import sys,time,json,runpy,numpy as np,matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt,matplotlib.mlab
m=runpy.run_path(sys.argv[1]);a=np.fromfile(sys.argv[2],dtype='<f8').reshape(-1,4);samples=[]
for i in range(16):
 start=time.perf_counter();fig=m['plot_specgram'](None,a,'chirp',200,'all');fig.set_size_inches(9,6);fig.savefig(sys.argv[3]);plt.close(fig);samples.append((time.perf_counter()-start)*1000)
print(json.dumps(dict(samples=samples[5:],python=sys.version.split()[0],numpy=np.__version__,matplotlib=matplotlib.__version__)))
`;
try{const bytes=Buffer.alloc(raw.byteLength);raw.forEach((v,i)=>bytes.writeDoubleLE(v,i*8));const input=join(dir,'input.bin');await writeFile(input,bytes);const ref=JSON.parse(execFileSync(process.env.PYTHON??'python3',['-c',source,fileURLToPath(new URL('../../scripts/graph_accelerometer.py',import.meta.url)),input,join(dir,'python.png')],{encoding:'utf8',maxBuffer:1024**2}));const samples:number[]=[];for(let i=0;i<16;i++){const at=performance.now();await writeSpectrogram(calculateSpectrogram(raw),'Spectrogram all (chirp)',200,join(dir,'node.png'),new AbortController().signal);if(i>=5)samples.push(performance.now()-at);}await writeSpectrogram(calculateSpectrogram(raw),'Spectrogram all (chirp)',200,'/tmp/spectrogram-review.png',new AbortController().signal);const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[Math.floor(a.length/2)],p95Ms:a[Math.ceil(a.length*.95)-1]};};console.log(JSON.stringify({node:process.version,python:ref.python,numpy:ref.numpy,matplotlib:ref.matplotlib,samples:8192,warmups:5,runs:11,nodePng:stats(samples),pythonPng:stats(ref.samples),scope:'Parsed samples through FFT, heatmap and 900x600 PNG file. Node atomic replace included. Different palettes/layouts; no pixel equivalence claim. Startup/IPC/input IO excluded.'},null,2));}finally{await rm(dir,{recursive:true,force:true});}
