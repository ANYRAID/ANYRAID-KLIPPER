import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {meshGrid,meshStatistics,meshDifference,duplicateMeshPoints,type MeshPoint} from '../src/diagnostics/mesh-analysis.ts';
const rows=200,cols=300,matrix=Array.from({length:rows},(_,r)=>Array.from({length:cols},(_,c)=>Math.sin(c*.01)*.2+Math.cos(r*.02)*.1)),params={min_x:10,max_x:310,min_y:20,max_y:220},path:MeshPoint[]=Array.from({length:10000},(_,i)=>[i%100,Math.floor(i/100)%90]);
const source=String.raw`
import sys,json,time,numpy as np
req=json.load(sys.stdin);z=np.array(req['matrix']);p=req['params'];path=np.array(req['path']);samples=[]
def run():
 dx=(p['max_x']-p['min_x'])/(z.shape[1]-1);dy=(p['max_y']-p['min_y'])/(z.shape[0]-1);x=np.array([p['min_x']+i*dx for i in range(z.shape[1])]);y=np.array([p['min_y']+i*dy for i in range(z.shape[0])]);a,b=np.meshgrid(x,y);unique,counts=np.unique(path,axis=0,return_counts=True);i=z.argmin();j=z.argmax()
 return dict(mean=z.mean(),standardDeviation=z.std(),absoluteMean=np.abs(z).mean(),minimum=dict(value=z.min(),x=a.ravel()[i],y=b.ravel()[i]),maximum=dict(value=z.max(),x=a.ravel()[j],y=b.ravel()[j]),duplicates=[dict(point=pt.tolist(),count=int(count)) for pt,count in zip(unique,counts) if count>1])
for i in range(16):
 start=time.perf_counter();result=run();samples.append((time.perf_counter()-start)*1000)
print(json.dumps(dict(result=result,samples=samples[5:],python=sys.version.split()[0],numpy=np.__version__)))
`;
const ref=JSON.parse(execFileSync(process.env.PYTHON??'python3',['-c',source],{input:JSON.stringify({matrix,params,path}),encoding:'utf8',maxBuffer:8*1024**2}));let maximumError=0;const samples:number[]=[];for(let i=0;i<16;i++){const at=performance.now(),grid=meshGrid(matrix,params),s=meshStatistics(grid),duplicates=duplicateMeshPoints(path);if(i>=5)samples.push(performance.now()-at);for(const key of ['mean','standardDeviation','absoluteMean'] as const){const error=Math.abs(s[key]-ref.result[key]);maximumError=Math.max(maximumError,error);assert.ok(error<=1e-14);}for(const key of ['minimum','maximum'] as const)for(const field of ['value','x','y'] as const){const error=Math.abs(s[key][field]-ref.result[key][field]);maximumError=Math.max(maximumError,error);assert.ok(error<=1e-12);}assert.deepEqual(duplicates,ref.result.duplicates);assert.ok(meshDifference(grid,grid)!.z.every(v=>v===0));}
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};};console.log(JSON.stringify({node:process.version,python:ref.python,numpy:ref.numpy,rows,cols,pathPoints:path.length,warmups:5,runs:11,nodeAnalysis:stats(samples),numpyAnalysis:stats(ref.samples),maximumError,scope:'Validated matrix/grid, statistics and path duplicates vs NumPy operations used by graph_mesh.py. Correct max_y is explicit; legacy max_x typo not reproduced. Input parsing, stdout formatting and process startup excluded. Node compacts coordinate vectors instead of full meshgrid arrays.'},null,2));
