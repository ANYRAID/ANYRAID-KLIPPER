import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {parseAccelerometerLog} from '../src/calibration/accelerometer-log.ts';
import {accelerometerPlots} from '../src/diagnostics/graph-accelerometer.ts';
import {writeStatsPanels} from '../src/diagnostics/graphstats-file.ts';
const oracle=String.raw`
import sys,types,runpy,json,time
plots=[]
class Stub:
 def __getattr__(self,n):return lambda *a,**k:None
class Axis(Stub):
 def __init__(self):self.curves=[];plots.append(self.curves);self.xaxis=self.yaxis=Stub()
 def plot(self,x,y,**kw):self.curves.append(dict(times=x.tolist(),values=y.tolist()))
def subplots(**kw):
 plots.clear();axes=[Axis() for _ in range(kw.get('nrows',1))];return Stub(),axes if len(axes)>1 else axes[0]
m=types.ModuleType('matplotlib');m.pyplot=types.SimpleNamespace(subplots=subplots);m.font_manager=types.SimpleNamespace(FontProperties=Stub);m.ticker=types.SimpleNamespace(AutoMinorLocator=Stub);sys.modules['matplotlib']=m
r=runpy.run_path(sys.argv[1]);data=r['parse_log'](sys.argv[2],None);samples=[]
for i in range(16):
 start=time.perf_counter()
 if sys.argv[3]=='raw':r['plot_accel'](None,[data],[sys.argv[2]])
 else:r['plot_frequency'](None,[data],[sys.argv[2]],200,'all')
 samples.append((time.perf_counter()-start)*1000)
print(json.dumps(dict(plots=plots,samples=samples),allow_nan=False))
`;
const text=Array.from({length:8192},(_,i)=>`${i/3200},${3+200*Math.sin(2*Math.PI*43*i/3200)},${100*Math.cos(2*Math.PI*67*i/3200)},${50*Math.sin(2*Math.PI*123*i/3200)}`).join('\n'),dir=mkdtempSync(join(tmpdir(),'accel-graph-bench-')),file=join(dir,'raw.csv'),reports=[],stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[Math.floor(a.length/2)],p95Ms:a[Math.ceil(a.length*.95)-1]};};writeFileSync(file,text);
try{for(const raw of [true,false]){const log=parseAccelerometerLog(text,file),reference=JSON.parse(execFileSync(process.env.PYTHON??'python3',['-c',oracle,fileURLToPath(new URL('../../scripts/graph_accelerometer.py',import.meta.url)),file,raw?'raw':'frequency'],{encoding:'utf8',maxBuffer:16*1024**2})),samples:number[]=[],exports:number[]=[];let maxError=0;for(let i=0;i<16;i++){const start=performance.now(),panels=accelerometerPlots([log],{raw});if(i>=5)samples.push(performance.now()-start);panels.forEach((p,j)=>p.plot.curves.forEach((c,k)=>{const r=reference.plots[j][k];assert.equal(c.times.length,r.times.length);c.times.forEach((v,n)=>assert.ok(Math.abs(v-r.times[n])<1e-9));c.values.forEach((v,n)=>{const error=Math.abs(v-r.values[n]);maxError=Math.max(maxError,error);assert.ok(error<=1e-9+Math.abs(r.values[n])*1e-10);});}));const at=performance.now();await writeStatsPanels(panels,`/tmp/accelerometer-${raw?'raw':'frequency'}-review.png`,new AbortController().signal);if(i>=5)exports.push(performance.now()-at);}reports.push({raw,node:stats(samples),python:stats(reference.samples.slice(5)),pngExport:stats(exports),maxError});}console.log(JSON.stringify({node:process.version,samples:8192,warmups:5,runs:11,reports,scope:'Raw graph centering or FFT plus frequency curves from parsed input. Original Python plot functions with recording Matplotlib. File parsing/startup/IPC excluded; Node PNG export separate.'},null,2));}finally{rmSync(dir,{recursive:true,force:true});}
