import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {meshPathPlot,renderMeshPathSvg,type MeshPathType} from '../src/diagnostics/mesh-path.ts';
import {writePlotDocument} from '../src/diagnostics/graphstats-file.ts';
const points=Array.from({length:900},(_,i)=>[(Math.floor(i/30)%2?29-i%30:i%30)*5,Math.floor(i/30)*5]),data={calibration:{points:[...points,[150,150]],probe_path:points,rapid_path:points.map((p,i)=>[p,i%3!==0])}};
const source=String.raw`
import sys,json,runpy,types,time
m=runpy.run_path(sys.argv[1]);data=json.load(sys.stdin);results={};args=types.SimpleNamespace(animate=False,scale_plot=False,output='unused')
for kind,fn in [('points','plot_probe_points'),('path','plot_probe_path'),('rapid','plot_rapid_path')]:
 captured=[];plt=m[fn].__globals__['plt'];plt.title=plt.xlabel=plt.ylabel=lambda *a:None
 def plot(x,y,style):captured.append(dict(x=list(map(float,x)),y=list(map(float,y)),style=style));return [None]
 plt.plot=plot;samples=[]
 for i in range(16):
  captured=[];start=time.perf_counter();m[fn](data,args);samples.append((time.perf_counter()-start)*1000)
 results[kind]=dict(samples=samples[5:],curves=captured)
print(json.dumps(results))
`;
const ref=JSON.parse(execFileSync(process.env.PYTHON??'python3',['-c',source,fileURLToPath(new URL('../../scripts/graph_mesh.py',import.meta.url))],{input:JSON.stringify(data),encoding:'utf8',maxBuffer:4*1024**2}));const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};};for(const kind of ['points','path','rapid'] as MeshPathType[]){const samples:number[]=[];let model=meshPathPlot(data,kind);for(let i=0;i<16;i++){const at=performance.now();model=meshPathPlot(data,kind);if(i>=5)samples.push(performance.now()-at);}const groups=kind==='points'?[model.sampled]:[model.travel,model.sampled,[model.travel[0]],[model.travel.at(-1)!],model.missing];assert.equal(groups.length,ref[kind].curves.length);groups.forEach((points,i)=>{assert.deepEqual(points.map(p=>p[0]),ref[kind].curves[i].x);assert.deepEqual(points.map(p=>p[1]),ref[kind].curves[i].y);});console.log(JSON.stringify({kind,node:stats(samples),python:stats(ref[kind].samples),points:900,scope:'Path computation/recorded plot arrays, exact coordinates. Original Matplotlib plot calls replaced by a recording backend. Startup, IO and actual rendering excluded.'}));}
const model=meshPathPlot(data,'rapid'),samples:number[]=[];for(let i=0;i<16;i++){const at=performance.now();await writePlotDocument(model,()=>renderMeshPathSvg(model),'/tmp/mesh-path-review.png',new AbortController().signal);if(i>=5)samples.push(performance.now()-at);}console.log(JSON.stringify({nodePng:stats(samples),scope:'SVG construction, PNG encoding and atomic file replacement, measured separately; no Python rendering baseline.'}));
