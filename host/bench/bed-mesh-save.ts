import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {BedMesh} from '../src/motion/bed-mesh.ts';
import {bedMeshProfileChanges} from '../src/motion/bed-mesh-save.ts';
const params={min_x:-0,max_x:200,min_y:1e-7,max_y:200,x_count:11,y_count:11,mesh_x_pps:0,mesh_y_pps:0,algo:'direct' as const,tension:.2},points=Array.from({length:11},(_,y)=>Array.from({length:11},(_,x)=>Math.sin(x+y)*.25));points[0]=[-0,.0078125,-.0078125,.123456789,-.123456789,1e-8,-1e-8,.5,-.5,1.2345675,-1.2345675];const mesh=new BedMesh(params,points);
const py=String.raw`
import sys,json,ast,types,collections,time
r=json.load(sys.stdin);tree=ast.parse(open(sys.argv[1]).read());ns=dict(collections=collections,PROFILE_VERSION=1);exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='ProfileManager'],type_ignores=[]),sys.argv[1],'exec'),ns)
a=ns['ProfileManager'].__new__(ns['ProfileManager']);values={};a.name='bed_mesh';a.profiles={};a.gcode=types.SimpleNamespace(respond_info=lambda *args:None);mesh=types.SimpleNamespace(get_probed_matrix=lambda:r['points'],get_mesh_params=lambda:r['params']);a.bedmesh=types.SimpleNamespace(get_mesh=lambda:mesh,update_status=lambda:None);a.printer=types.SimpleNamespace(lookup_object=lambda name:types.SimpleNamespace(set=lambda section,key,value:values.__setitem__(key,str(value))))
a.save_profile('test');result=dict(values);times=[]
for i in range(16):
 start=time.perf_counter()
 for j in range(1000):a.save_profile('test')
 times.append((time.perf_counter()-start)*1000)
print(json.dumps(dict(result=result,times=times[5:],python=sys.version.split()[0])))
`;
// JSON represents negative zero as zero; send its exact token explicitly.
const input=JSON.stringify({params,points}).replace('"min_x":0','"min_x":-0.0').replace('"points":[[0,','"points":[[-0.0,');
const ref=JSON.parse(execFileSync(process.env.PYTHON??'python3',['-c',py,fileURLToPath(new URL('../../klippy/extras/bed_mesh.py',import.meta.url))],{input,encoding:'utf8'}));const actual=Object.fromEntries(bedMeshProfileChanges('test',mesh).map(c=>{if(c.kind!=='set')throw new Error('unexpected remove');return [c.option,c.value];}));assert.equal(actual.points,ref.result.points);assert.equal(actual.version,ref.result.version);assert.equal(actual.algo,ref.result.algo);for(const key of Object.keys(params))if(key!=='algo')assert.equal(Number(actual[key]),Number(ref.result[key]));
const times:number[]=[];for(let i=0;i<16;i++){const start=performance.now();for(let j=0;j<1000;j++)bedMeshProfileChanges('test',mesh);if(i>=5)times.push(performance.now()-start);}const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};};console.log(JSON.stringify({node:process.version,python:ref.python,points:121,profilesPerBatch:1000,exactPointText:true,exactNumericParameters:true,nodeTime:stats(times),pythonTime:stats(ref.times),scope:'Actual ProfileManager.save_profile with config/status stubs versus frozen Node persistence batch generation. Config validation, disk write and active profile selection excluded.'},null,2));
