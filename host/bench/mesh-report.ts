import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {analyzeMeshDump,formatMeshReport} from '../src/diagnostics/mesh-report.ts';
const params={min_x:0,max_x:200,min_y:0,max_y:200},matrix=(offset:number)=>Array.from({length:100},(_,r)=>Array.from({length:150},(_,c)=>Math.sin(c*.03)*.2+Math.cos(r*.05)*.1+offset));
const fixture={calibration:{points:[[0,0],[1,1]],probe_path:[[0,0],[1,1]],rapid_path:[[[0,0],true],[[1,1],true]]},current_mesh:{name:'current',mesh_params:params,probed_matrix:matrix(0)},profiles:Object.fromEntries([1,2,3].map(i=>['profile'+i,{points:matrix(i*.01),mesh_params:params}]))};
const source=String.raw`
import sys,json,runpy,io,time,types
m=runpy.run_path(sys.argv[1]);data=json.load(sys.stdin);fn=m['analyze'];g=fn.__globals__;g['request_mesh_data']=lambda _:data;args=types.SimpleNamespace(input='unused');saved=sys.stdout;samples=[]
for i in range(16):
 sys.stdout=io.StringIO();start=time.perf_counter();fn(args);samples.append((time.perf_counter()-start)*1000)
meshes=[];comparisons=[]
def stats(a):
 x,y,z=a;i=z.argmin();j=z.argmax();return dict(mean=float(z.mean()),standardDeviation=float(z.std()),minimum=dict(value=float(z.min()),x=float(x.ravel()[i]),y=float(y.ravel()[i])),maximum=dict(value=float(z.max()),x=float(x.ravel()[j]),y=float(y.ravel()[j])))
g['_analyze_mesh']=lambda name,a:meshes.append(dict(name=name,statistics=stats(a)))
def compare(na,nb,a,b):
 ax,ay,az=a;bx,by,bz=b
 if (ax==bx).all() and (ay==by).all():comparisons.append(dict(fromName=na,to=nb,statistics=stats((ax,ay,az-bz))))
g['_compare_mesh']=compare;fn(args);sys.stdout=saved;print(json.dumps(dict(samples=samples[5:],meshes=meshes,comparisons=comparisons)))
`;
const ref=JSON.parse(execFileSync(process.env.PYTHON??'python3',['-c',source,fileURLToPath(new URL('../../scripts/graph_mesh.py',import.meta.url))],{input:JSON.stringify(fixture),encoding:'utf8',maxBuffer:8*1024**2}));const times:number[]=[];let maxError=0;for(let i=0;i<16;i++){const at=performance.now(),report=analyzeMeshDump(fixture);formatMeshReport(report);if(i>=5)times.push(performance.now()-at);assert.deepEqual(report.meshes.map(m=>m.name),ref.meshes.map((m:{name:string})=>m.name));const compare=(a:any,b:any)=>{for(const key of Object.keys(b))if(typeof b[key]==='number'){maxError=Math.max(maxError,Math.abs(a[key]-b[key]));assert.ok(Math.abs(a[key]-b[key])<=1e-12);}else if(typeof b[key]==='object')compare(a[key],b[key]);};report.meshes.forEach((m,k)=>compare(m.statistics,ref.meshes[k].statistics));assert.equal(report.comparisons.length,ref.comparisons.length);report.comparisons.forEach((c,k)=>{assert.equal(c.from,ref.comparisons[k].fromName);assert.equal(c.to,ref.comparisons[k].to);compare(c.statistics,ref.comparisons[k].statistics);});}const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};};console.log(JSON.stringify({node:process.version,meshes:4,rows:100,columns:150,warmups:5,runs:11,nodeReport:stats(times),pythonReport:stats(ref.samples),maxError,scope:'Original analyze with in-memory request/stdout; square extent avoids legacy max_y typo. Report computation and text formatting, no input parsing/file IO/startup. Node also validates and retains structured report.'},null,2));
