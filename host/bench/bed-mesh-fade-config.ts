import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {BedMesh} from '../src/motion/bed-mesh.ts';
import {BedMeshFade,type BedMeshFadeConfig} from '../src/motion/bed-mesh-fade.ts';
const params={min_x:0,max_x:20,min_y:0,max_y:20,x_count:2,y_count:2,mesh_x_pps:0,mesh_y_pps:0,algo:'direct' as const,tension:.2};
const cases=[{}, {end:10},{end:10,target:null},{end:10,target:0},{end:10,target:.12},{end:10,target:.125},{end:10,target:2},{start:0,end:.1},{start:2,end:1,target:2}] satisfies BedMeshFadeConfig[];
const source=String.raw`
import sys,json,ast,math,logging,types,time
r=json.load(sys.stdin);tree=ast.parse(open(sys.argv[1]).read());ns=dict(math=math,logging=logging,BedMeshError=RuntimeError);names=['BedMesh','ZMesh','lerp','constrain'];nodes=[n for n in tree.body if isinstance(n,(ast.ClassDef,ast.FunctionDef)) and n.name in names];exec(compile(ast.Module(body=nodes,type_ignores=[]),sys.argv[1],'exec'),ns);ns['ZMesh'].print_mesh=lambda *a:None
m=ns['ZMesh'](r['params'],'test');m.build_mesh([[.125,.125],[.125,.125]])
b=ns['BedMesh'].__new__(ns['BedMesh']);b.gcode=types.SimpleNamespace(error=ValueError);b.printer=types.SimpleNamespace(lookup_object=lambda name:types.SimpleNamespace(reset_last_position=lambda:None));b.update_status=lambda:None;b.splitter=types.SimpleNamespace(initialize=lambda *a:None)
def run(c,mesh):
 b.fade_start=c.get('start',1.);b.fade_end=c.get('end',0.);b.fade_dist=b.fade_end-b.fade_start
 if b.fade_dist<=0:b.fade_start=b.fade_end=b.FADE_DISABLE
 b.base_fade_target=c.get('target');b.set_mesh(mesh);return b.fade_target
results=[]
for mesh in [m,None]:
 for c in r['cases']:
  try:results.append(dict(target=run(c,mesh)))
  except ValueError:results.append(dict(error=True))
times=[]
for i in range(16):
 start=time.perf_counter()
 for j in range(1000):run(dict(end=10.),m)
 times.append((time.perf_counter()-start)*1000)
print(json.dumps(dict(results=results,times=times[5:],python=sys.version.split()[0])))
`;
const ref=JSON.parse(execFileSync(process.env.PYTHON??'python3',['-c',source,fileURLToPath(new URL('../../klippy/extras/bed_mesh.py',import.meta.url))],{input:JSON.stringify({params,cases}),encoding:'utf8'}));const mesh=new BedMesh(params,[[.125,.125],[.125,.125]]);let index=0;for(const m of [mesh,null])for(const config of cases){let actual;try{actual={target:BedMeshFade.forMesh(m,config).target};}catch{actual={error:true};}assert.deepEqual(actual,ref.results[index++]);}
const times:number[]=[];for(let i=0;i<16;i++){const start=performance.now();for(let j=0;j<1000;j++)BedMeshFade.forMesh(mesh,{end:10});if(i>=5)times.push(performance.now()-start);}const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};};console.log(JSON.stringify({node:process.version,python:ref.python,cases:index,targetsAndRejectionsExact:true,resolutions:1000,nodeTime:stats(times),pythonTime:stats(ref.times),scope:'AST original BedMesh.set_mesh and ZMesh, config fade defaults emulated; status/reset/splitter callbacks stubbed. Python object reused, Node immutable object created. Configuration-only timing, no queue/hardware.'},null,2));
