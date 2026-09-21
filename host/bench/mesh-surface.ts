import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {meshSurfacePlot,renderMeshSurfaceSvg,type MeshSurfaceType} from '../src/diagnostics/mesh-surface.ts';
import {writePlotDocument} from '../src/diagnostics/graphstats-file.ts';
const matrix=(rows:number,cols:number,offset=0)=>Array.from({length:rows},(_,r)=>Array.from({length:cols},(_,c)=>Math.sin(c/(cols-1)*Math.PI)*.2+Math.cos(r/(rows-1)*Math.PI)*.1+offset)),params={min_x:0,max_x:200,min_y:0,max_y:200,x_count:40,y_count:30},data={current_mesh:{name:'current',probed_matrix:matrix(30,40),mesh_matrix:matrix(61,81),mesh_params:params},profiles:{saved:{points:matrix(30,40,.025),mesh_params:params}}};
const source=String.raw`
import sys,json,runpy,time,types
m=runpy.run_path(sys.argv[1]);data=json.load(sys.stdin);g=m['plot_overlay'].__globals__;records=[]
def record(ax,matrix,params,cmap=None,label=None):
 x,y,z=g['_format_mesh_data'](matrix,params);records.append(dict(x=x.tolist(),y=y.tolist(),z=z.tolist()));return None,max(abs(z.min()),abs(z.max()))*3
axis=types.SimpleNamespace(set_title=lambda *a:None,set=lambda **kw:None,legend=lambda **kw:None);g['_plot_mesh']=record;g['plt'].subplot=lambda **kw:axis;g['plt'].gcf=lambda:types.SimpleNamespace(colorbar=lambda *a,**kw:None)
results={}
for kind,fn in [('probedz','plot_probed_matrix'),('meshz','plot_mesh_matrix'),('overlay','plot_overlay'),('delta','plot_delta')]:
 args=types.SimpleNamespace(profile_name='saved' if kind in ['overlay','delta'] else None,scale_plot=False);samples=[]
 for i in range(16):
  records=[];start=time.perf_counter();g[fn](data,args);samples.append((time.perf_counter()-start)*1000)
 results[kind]=dict(samples=samples[5:],surfaces=records)
print(json.dumps(results))
`;
const ref=JSON.parse(execFileSync(process.env.PYTHON??'python3',['-c',source,fileURLToPath(new URL('../../scripts/graph_mesh.py',import.meta.url))],{input:JSON.stringify(data),encoding:'utf8',maxBuffer:8*1024**2}));const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};};for(const kind of ['probedz','meshz','overlay','delta'] as MeshSurfaceType[]){const samples:number[]=[];let model=meshSurfacePlot(data,kind,kind==='overlay'||kind==='delta'?'saved':undefined);for(let i=0;i<16;i++){const at=performance.now();model=meshSurfacePlot(data,kind,kind==='overlay'||kind==='delta'?'saved':undefined);if(i>=5)samples.push(performance.now()-at);}assert.equal(model.surfaces.length,ref[kind].surfaces.length);model.surfaces.forEach((s,k)=>{const expected=ref[kind].surfaces[k];assert.deepEqual(s.z,expected.z.flat());for(let r=0;r<s.y.length;r++){assert.deepEqual(s.x,expected.x[r]);assert.ok(expected.y[r].every((v:number)=>v===s.y[r]));}});console.log(JSON.stringify({kind,node:stats(samples),python:stats(ref[kind].samples),scope:'Original Python surface functions with recorded arrays instead of Matplotlib rendering. Node validates and stores compact coordinate vectors; square ranges avoid legacy Y typo. Exact coordinate/height equality.'}));}
const model=meshSurfacePlot(data,'overlay','saved'),samples:number[]=[];for(let i=0;i<16;i++){const at=performance.now();await writePlotDocument(model,()=>renderMeshSurfaceSvg(model),'/tmp/mesh-surface-review.png',new AbortController().signal);if(i>=5)samples.push(performance.now()-at);}console.log(JSON.stringify({nodePng:stats(samples),scope:'Surface SVG generation, PNG encoding and atomic file replacement; no Python image baseline. Two 30x40 grids.'}));
