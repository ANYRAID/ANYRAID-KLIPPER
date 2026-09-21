import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {BedMesh} from '../src/motion/bed-mesh.ts';
import {BedMeshProfiles} from '../src/motion/bed-mesh-profiles.ts';
import {BedMeshProfileStore} from '../src/motion/bed-mesh-profile-store.ts';
import {KlipperSaveSession} from '../src/config/klipper-save-session.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {parseKlipperMainText} from '../src/config/klipper-text.ts';
const params={min_x:0,max_x:20,min_y:0,max_y:20,x_count:2,y_count:2,mesh_x_pps:0,mesh_y_pps:0,algo:'direct' as const,tension:.2},points=[[.123456789,.4],[.5,.6]],ops=[['save','a'],['save','b'],['remove','a'],['remove','absent'],['save','a']];
const py=String.raw`
import sys,json,ast,types,collections,time,copy
r=json.load(sys.stdin);tree=ast.parse(open(sys.argv[1]).read());ns=dict(collections=collections,PROFILE_VERSION=1);exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='ProfileManager'],type_ignores=[]),sys.argv[1],'exec'),ns)
a=ns['ProfileManager'].__new__(ns['ProfileManager']);a.name='bed_mesh';a.profiles={};a.gcode=types.SimpleNamespace(respond_info=lambda *args:None);mesh=types.SimpleNamespace(get_probed_matrix=lambda:r['points'],get_mesh_params=lambda:r['params']);a.bedmesh=types.SimpleNamespace(get_mesh=lambda:mesh,update_status=lambda:None);a.printer=types.SimpleNamespace(lookup_object=lambda name:types.SimpleNamespace(set=lambda *args:None,remove_section=lambda *args:None));results=[]
for action,name in r['ops']:
 getattr(a,action+'_profile')(name);results.append(copy.deepcopy(a.get_profiles()))
times=[]
for i in range(16):
 start=time.perf_counter()
 for j in range(20):a.save_profile('a')
 times.append((time.perf_counter()-start)*1000)
print(json.dumps(dict(results=results,times=times[5:],python=sys.version.split()[0])))
`;
const ref=JSON.parse(execFileSync(process.env.PYTHON??'python3',['-c',py,fileURLToPath(new URL('../../klippy/extras/bed_mesh.py',import.meta.url))],{input:JSON.stringify({params,points,ops}),encoding:'utf8'}));const session=new KlipperSaveSession('/unused',''),store=new BedMeshProfileStore(new BedMeshProfiles(new ConfigurationReader(parseKlipperMainText('','/unused'),null)),session),mesh=new BedMesh(params,points),results=[];
for(const [action,name] of ops){if(action==='save')store.save(name,mesh);else store.remove(name);results.push(store.status);}assert.deepEqual(JSON.parse(JSON.stringify(results)),ref.results);
const times:number[]=[];for(let i=0;i<16;i++){const start=performance.now();for(let j=0;j<20;j++)store.save('a',mesh);if(i>=5)times.push(performance.now()-start);}const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};};console.log(JSON.stringify({node:process.version,python:ref.python,operations:ops.length,statusExact:true,savesPerBatch:20,nodeTime:stats(times),pythonTime:stats(ref.times),scope:'Python actual profile save/remove with config stubs; Node includes real pending config validation and owned mesh reconstruction. No disk writes, active mesh switch or equal-work speedup claim.'},null,2));
