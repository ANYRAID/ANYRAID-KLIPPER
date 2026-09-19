import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir,cpus} from 'node:os';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {inputShaper,shaperConfigs} from '../src/motion/shaper.ts';
import type {ShaperName,ShaperOptions} from '../src/motion/shaper.ts';
import {shaperResponse,remainingVibrations,shaperSmoothing,shaperMaxAcceleration} from '../src/calibration/shaper.ts';
type Case={name:ShaperName;frequency:number;damping:number;options:ShaperOptions};
const cases:Case[]=[];
for(const name of Object.keys(shaperConfigs) as ShaperName[])for(const frequency of [5,23,40,100,200])for(const damping of [0,.1,shaperConfigs[name].maxDamping])cases.push({name,frequency,damping,options:{}});
for(let n=3;n<=10;n++)for(const t of [.5,.75])cases.push({name:'mzv',frequency:40,damping:.1,options:{n,t}});
for(const tau of [.5,1,1.5,2])cases.push({name:'mzv',frequency:60,damping:.15,options:{n:5,tau}});
const frequencies=Float64Array.from({length:1024},(_,i)=>i*.25),psd=Float64Array.from(frequencies,f=>.01+Math.exp(-(((f-40)/7)**2))+.4*Math.exp(-(((f-80)/9)**2)));
const python=String.raw`
import sys,json,time
sys.path.insert(0,sys.argv[1]);from extras import shaper_defs,shaper_calibrate
import numpy as np
cal=shaper_calibrate.ShaperCalibrate(None)
data=json.load(open(sys.argv[2]));freqs=np.array(data['frequencies']);psd=np.array(data['psd'])
def initialize(c):
 name=c['name'];opts=c['options'];return next(s for s in shaper_defs.INPUT_SHAPERS if s.name==name).init_func(c['frequency'],c['damping'],**opts)
# Preserve original bisection steps, but report floating-point stagnation instead
# of allowing the migration oracle to hang forever at extreme damping.
def guarded_bisect(func):
 left=right=1.
 if not func(1e-9):return 0.
 while not func(left):right=left;left*=.5
 if right==left:
  while func(right):right*=2.
 while right-left>1e-8:
  middle=(left+right)*.5
  if middle==left or middle==right:return None
  if func(middle):left=middle
  else:right=middle
 return left
cal._bisect=guarded_bisect
results=[]
for c in data['cases']:
 try:
  shaper=initialize(c);v,response=cal._estimate_remaining_vibrations(shaper,.1,freqs,psd)
  results.append({'amplitudes':shaper[0],'times':shaper[1],'response':response.tolist(),'vibrations':float(v),'smoothing':cal._get_shaper_smoothing(shaper),'accel':cal.find_shaper_max_accel(shaper,5.)})
 except shaper_defs.ShaperError as e:results.append({'error':str(e)})
def setup():
 for _ in range(10):
  for c in data['cases'][:90]:initialize(c)
shapers=[initialize(c) for c in data['cases'][:90:15]]
def spectrum():
 for s in shapers:cal._estimate_remaining_vibrations(s,.1,freqs,psd)
def timing(fn):
 for _ in range(3):fn()
 times=[]
 for _ in range(11):
  t=time.perf_counter();fn();times.append((time.perf_counter()-t)*1000)
 return sorted(times)
print(json.dumps({'results':results,'setup':timing(setup),'spectrum':timing(spectrum)}))
`;
const dir=mkdtempSync(join(tmpdir(),'anyraid-shaper-'));
try{
 const input=join(dir,'input.json');writeFileSync(input,JSON.stringify({cases,frequencies:[...frequencies],psd:[...psd]}));
 const p=spawnSync(process.env.PYTHON??'python3',['-c',python,fileURLToPath(new URL('../../klippy',import.meta.url)),input],{encoding:'utf8',timeout:60000,maxBuffer:32*1024*1024});assert.equal(p.status,0,p.stderr||String(p.error));
 const oracle=JSON.parse(p.stdout);const errors={amplitudes:0,times:0,response:0,vibrations:0,smoothing:0,accel:0};let rejected=0,oracleBisectionStalls=0;
 const compare=(kind:keyof typeof errors,actual:number,expected:number,tol:number)=>{const diff=Math.abs(actual-expected);errors[kind]=Math.max(errors[kind],diff);assert(diff<=tol*Math.max(1,Math.abs(expected)),`${kind}: ${actual} != ${expected}`);};
 cases.forEach((c,i)=>{
  const expected=oracle.results[i];
  if(expected.error){assert.throws(()=>inputShaper(c.name,c.frequency,c.damping,c.options));rejected++;return;}
  const s=inputShaper(c.name,c.frequency,c.damping,c.options),r=remainingVibrations(s,.1,frequencies,psd);
  s.amplitudes.forEach((a,j)=>compare('amplitudes',a,expected.amplitudes[j],1e-11));s.times.forEach((t,j)=>compare('times',t,expected.times[j],1e-14));
  r.response.forEach((v,j)=>compare('response',v,expected.response[j],1e-11));compare('vibrations',r.vibrations,expected.vibrations,1e-11);
  compare('smoothing',shaperSmoothing(s),expected.smoothing,1e-11);if(expected.accel===null){oracleBisectionStalls++;assert(Number.isFinite(shaperMaxAcceleration(s)));}else compare('accel',shaperMaxAcceleration(s)!,expected.accel,1e-8);
 });
 const nativeSource=join(dir,'native.c'),nativeBinary=join(dir,'native');
 const nativeCases=cases.map(c=>inputShaper(c.name,c.frequency,c.damping,c.options));
 let source='#include <stdio.h>\n#include "'+fileURLToPath(new URL('../../klippy/chelper/kin_shaper.c',import.meta.url))+'"\n';
 source+='int main(void) { struct shaper_pulses sp; double max_gain_error=0., max_moment_error=0.;\n';
 for(const [i,s] of nativeCases.entries())source+=`{ double a[]={${s.amplitudes.join(',')}}; double t[]={${s.times.join(',')}}; if(init_shaper(${s.times.length},a,t,&sp))return 1; double gain=0.,moment=0.; for(int j=0;j<sp.num_pulses;j++){gain+=sp.pulses[j].a;moment+=sp.pulses[j].a*sp.pulses[j].t;} max_gain_error=fmax(max_gain_error,fabs(gain-1.));max_moment_error=fmax(max_moment_error,fabs(moment)); if(fabs(gain-1.)>1e-14 || fabs(moment)>1e-14)return ${i+2}; }\n`;
 source+='printf("%.17g %.17g\\n",max_gain_error,max_moment_error);return 0;}\n';writeFileSync(nativeSource,source);
 const cc=spawnSync(process.env.CC??'cc',['-O2','-std=gnu11','-ffunction-sections','-fdata-sections','-Wl,--gc-sections',nativeSource,'-lm','-o',nativeBinary],{encoding:'utf8',timeout:30000});assert.equal(cc.status,0,cc.stderr);
 const native=spawnSync(nativeBinary,[],{encoding:'utf8',timeout:10000});assert.equal(native.status,0,native.stderr);const [nativeGainError,nativeMomentError]=native.stdout.trim().split(' ').map(Number);
 const shapers=cases.slice(0,90).filter((_,i)=>i%15===0).map(c=>inputShaper(c.name,c.frequency,c.damping,c.options));
 const setup=()=>{for(let n=0;n<10;n++)for(const c of cases.slice(0,90))inputShaper(c.name,c.frequency,c.damping,c.options);};
 const spectrum=()=>{for(const s of shapers)remainingVibrations(s,.1,frequencies,psd);};
 const timing=(fn:()=>void)=>{for(let i=0;i<3;i++)fn();const times=[];for(let i=0;i<11;i++){const start=performance.now();fn();times.push(performance.now()-start);}return times.sort((a,b)=>a-b);};
 const a=timing(setup),b=timing(spectrum);
 console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,cases:cases.length,rejected,oracleBisectionStalls,nativeGainError,nativeMomentError,maxAbsoluteErrors:errors,setup:{count:900,nodeMedianMs:a[5],nodeP95Ms:a[10],pythonMedianMs:oracle.setup[5],pythonP95Ms:oracle.setup[10]},spectrum:{shapers:6,bins:1024,nodeMedianMs:b[5],nodeP95Ms:b[10],pythonMedianMs:oracle.spectrum[5],pythonP95Ms:oracle.spectrum[10]}},null,2));
}finally{rmSync(dir,{recursive:true,force:true});}
