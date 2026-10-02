import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir,cpus} from 'node:os';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {fitInputShapers} from '../src/calibration/shaper-fit.ts';
import type {FitOptions,FitResult} from '../src/calibration/shaper-fit.ts';
import {ShaperFitExecutor} from '../src/calibration/shaper-fit-executor.ts';
const datasets=[0,1].map(axis=>({frequencies:Float64Array.from({length:256},(_,i)=>i*.9+axis*.1),psd:Float64Array.from({length:256},(_,i)=>.01+Math.exp(-(((i*.9-42-axis*6)/7)**2))+.6*Math.exp(-(((i*.9-83)/12)**2)))}));
const cases:FitOptions[]=[{frequencies:[30,35,40,45,50,55,60,65,70,75,80]}, {range:{start:30.1,end:50.2,step:2.3},maxSmoothing:.1}, {frequencies:[30,40,50,60,70,80],maxVibrations:.04,squareCornerVelocity:10}, {shapers:['mzv(n=5,t=.75)','zvd'],frequencies:[35,40,45,50],testDamping:[.05,.15]}, {}];
const python=String.raw`
import sys,json,time
sys.path.insert(0,sys.argv[1]);from extras import shaper_calibrate
import numpy as np
raw=json.load(open(sys.argv[2]));cal=shaper_calibrate.ShaperCalibrate(None)
datasets=[shaper_calibrate.CalibrationData(str(i),np.array(d['frequencies']),np.array(d['psd']),None,None,None) for i,d in enumerate(raw['datasets'])]
for d in datasets[1:]:datasets[0].add_data(d)
def result(r):return {'name':r.name,'frequency':float(r.freq),'frequencies':r.freq_bins.tolist(),'values':r.vals.tolist(),'vibrations':float(r.vibrs),'smoothing':r.smoothing,'score':float(r.score),'maxAcceleration':r.max_accel}
def run(o):
 captured=[]
 def background(method,args):
  res=method(*args);captured.append(res[1:]);return res
 cal.background_process_exec=background
 frequencies=o.get('frequencies')
 if 'range' in o:frequencies=tuple(o['range'].get(k) for k in ['start','end','step'])
 best,shapers=cal.find_best_shaper(datasets[0],shapers=o.get('shapers'),shaper_freqs=frequencies,damping_ratio=o.get('damping'),scv=o.get('squareCornerVelocity',5),max_smoothing=o.get('maxSmoothing'),max_vibrations=o.get('maxVibrations'),test_damping_ratios=o.get('testDamping'),max_freq=o.get('maxFrequency'))
 return best,shapers,captured
results=[]
for o in raw['cases']:
 best,shapers,candidates=run(o);results.append({'best':result(best),'shapers':[result(r) for r in shapers],'candidates':[[result(r) for r in rs] for rs in candidates] if o else []})
for _ in range(3):run(raw['cases'][0])
times=[]
for _ in range(11):
 t=time.perf_counter();run(raw['cases'][0]);times.append((time.perf_counter()-t)*1000)
print(json.dumps({'results':results,'times':sorted(times)}))
`;
const dir=mkdtempSync(join(tmpdir(),'anyraid-shaper-fit-'));
try{
 const input=join(dir,'input.json');writeFileSync(input,JSON.stringify({cases,datasets:datasets.map(d=>({frequencies:[...d.frequencies],psd:[...d.psd]}))}));
 const p=spawnSync(process.env.PYTHON??'python3',['-c',python,fileURLToPath(new URL('../../klippy',import.meta.url)),input],{encoding:'utf8',timeout:60000,maxBuffer:32*1024*1024});assert.equal(p.status,0,p.stderr||String(p.error));const oracle=JSON.parse(p.stdout);
 let maxError=0,candidateCount=0,defaultCandidateCount=0;
 const compare=(a:FitResult,b:FitResult)=>{
  assert.equal(a.name,b.name);assert.equal(a.frequency,b.frequency);
  for(const key of ['vibrations','smoothing','score','maxAcceleration'] as const){maxError=Math.max(maxError,Math.abs(a[key]-b[key]));assert(Math.abs(a[key]-b[key])<=1e-9*Math.max(1,Math.abs(b[key])),key);}
  for(const key of ['frequencies','values'] as const){assert.equal(a[key].length,b[key].length);a[key].forEach((v,i)=>{maxError=Math.max(maxError,Math.abs(v-b[key][i]));assert(Math.abs(v-b[key][i])<=1e-10*Math.max(1,Math.abs(b[key][i])),key);});}
 };
 cases.forEach((o,i)=>{const a=fitInputShapers(datasets,o),b=oracle.results[i];compare(a.best,b.best);a.shapers.forEach((r,j)=>compare(r,b.shapers[j]));if(!b.candidates.length){defaultCandidateCount=a.candidates.reduce((n,rs)=>n+rs.length,0);return;}a.candidates.forEach((rs,j)=>{assert.equal(rs.length,b.candidates[j].length);rs.forEach((r,k)=>{candidateCount++;compare(r,b.candidates[j][k]);});});});
 for(let i=0;i<3;i++)fitInputShapers(datasets,cases[0]);const times=[];for(let i=0;i<11;i++){const t=performance.now();fitInputShapers(datasets,cases[0]);times.push(performance.now()-t);}times.sort((a,b)=>a-b);
 let ticks=0,maxTickDelay=0,last=performance.now();const timer=setInterval(()=>{const now=performance.now();maxTickDelay=Math.max(maxTickDelay,now-last);last=now;ticks++;},5);
 const start=performance.now();let workerResult;
 try{workerResult=await new ShaperFitExecutor().fit(datasets.map(d=>({frequencies:d.frequencies.slice(),psd:d.psd.slice()})),cases.at(-1)!);}finally{clearInterval(timer);}
 compare(workerResult.best,oracle.results.at(-1).best);
 console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,fixtures:cases.length,candidateCount,defaultCandidateCount,maxAbsoluteError:maxError,nodeMedianMs:times[5],nodeP95Ms:times[10],pythonMedianMs:oracle.times[5],pythonP95Ms:oracle.times[10],speedup:oracle.times[5]/times[5],workerMs:performance.now()-start,mainThreadTimerTicks:ticks,maxTickIntervalMs:maxTickDelay},null,2));
}finally{rmSync(dir,{recursive:true,force:true});}
