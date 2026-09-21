import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {BedMesh} from '../src/motion/bed-mesh.ts';
import {BedMeshMovePort} from '../src/motion/bed-mesh-port.ts';
import {motionLimits} from '../src/motion/lookahead.ts';
const levels=[.1,.3,null,.125],position=[10,10,5,1],meshes=levels.map(z=>z===null?null:new BedMesh({min_x:0,max_x:20,min_y:0,max_y:20,x_count:2,y_count:2,mesh_x_pps:0,mesh_y_pps:0,algo:'direct',tension:.2},[[z,z],[z,z]]));
const py=String.raw`
import sys,json,ast,types,time
r=json.load(sys.stdin);tree=ast.parse(open(sys.argv[1]).read());ns=dict(constrain=lambda v,low,high:max(low,min(high,v)));exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='BedMesh'],type_ignores=[]),sys.argv[1],'exec'),ns);b=ns['BedMesh'].__new__(ns['BedMesh']);b.fade_start=1.;b.fade_end=10.;b.fade_dist=9.;b.base_fade_target=None;b.last_position=[0.,0.,0.,0.];b.splitter=types.SimpleNamespace(initialize=lambda *a:None);b.update_status=lambda:None;b.gcode=types.SimpleNamespace(error=ValueError);b.toolhead=types.SimpleNamespace(get_position=lambda:list(r['position']));b.printer=types.SimpleNamespace(lookup_object=lambda name:types.SimpleNamespace(reset_last_position=lambda:b.get_position()));meshes=[None if z is None else types.SimpleNamespace(get_z_average=lambda z=z:round(z,2),get_z_range=lambda z=z:(z,z),calc_z=lambda x,y,z=z:z) for z in r['levels']]
results=[]
for mesh in meshes:b.set_mesh(mesh);results.append(b.get_position())
times=[]
for i in range(16):
 start=time.perf_counter()
 for j in range(1000):b.set_mesh(meshes[j%4])
 times.append((time.perf_counter()-start)*1000)
print(json.dumps(dict(results=results,times=times[5:],python=sys.version.split()[0])))
`;
const ref=JSON.parse(execFileSync(process.env.PYTHON??'python3',['-c',py,fileURLToPath(new URL('../../klippy/extras/bed_mesh.py',import.meta.url))],{input:JSON.stringify({levels,position}),encoding:'utf8'})),p=new BedMeshMovePort({mesh:null,physicalPosition:position,limits:motionLimits(300,3000),validate:()=>{}}),drain=async()=>{};
const results=[];for(const mesh of meshes)results.push(await p.replaceMesh(mesh,{start:1,end:10},drain));assert.deepEqual(results,ref.results);const times:number[]=[];for(let i=0;i<16;i++){const start=performance.now();for(let j=0;j<1000;j++)await p.replaceMesh(meshes[j%4],{start:1,end:10},drain);if(i>=5)times.push(performance.now()-start);}assert.deepEqual(p.plannedPosition,position);const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};};console.log(JSON.stringify({node:process.version,python:ref.python,cases:4,positionExact:true,switchesPerBatch:1000,nodeTime:stats(times),pythonTime:stats(ref.times),scope:'Python actual set_mesh/get_position with constant mesh fixtures vs Node owned meshes and asynchronous drain stub. Includes auto fade target and clear; no hardware drain or physical position feedback.'},null,2));
