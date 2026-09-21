import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {BedMesh} from '../src/motion/bed-mesh.ts';
import {BedMeshProfiles} from '../src/motion/bed-mesh-profiles.ts';
import {BedMeshProfileStore} from '../src/motion/bed-mesh-profile-store.ts';
import {registerBedMeshProfile} from '../src/motion/bed-mesh-profile-command.ts';
import {KlipperSaveSession} from '../src/config/klipper-save-session.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {parseKlipperMainText} from '../src/config/klipper-text.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
const cases=[{LOAD:'p',SAVE:'q'},{SAVE:'default'},{SAVE:'q'},{REMOVE:'q'},{},{LOAD:' '}];
const py=String.raw`
import sys,json,ast,types,time
r=json.load(sys.stdin);tree=ast.parse(open(sys.argv[1]).read());import collections
ns=dict(collections=collections);exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='ProfileManager'],type_ignores=[]),sys.argv[1],'exec'),ns);a=ns['ProfileManager'].__new__(ns['ProfileManager']);events=[]
a.load_profile=lambda name:events.append(['LOAD',name]);a.save_profile=lambda name:events.append(['SAVE',name]);a.remove_profile=lambda name:events.append(['REMOVE',name])
def run(params):
 g=types.SimpleNamespace(get=lambda key,default:params.get(key,default),error=ValueError,respond_info=lambda msg:None,get_commandline=lambda:'BED_MESH_PROFILE')
 try:a.cmd_BED_MESH_PROFILE(g)
 except ValueError:events.append(['ERROR'])
for params in r:run(params)
result=list(events);times=[]
for i in range(16):
 events.clear();start=time.perf_counter()
 for j in range(1000):run(dict(LOAD='p'))
 times.append((time.perf_counter()-start)*1000)
print(json.dumps(dict(events=result,times=times[5:],python=sys.version.split()[0])))
`;
const ref=JSON.parse(execFileSync(process.env.PYTHON??'python3',['-c',py,fileURLToPath(new URL('../../klippy/extras/bed_mesh.py',import.meta.url))],{input:JSON.stringify(cases),encoding:'utf8'}));
const session=new KlipperSaveSession('/unused',''),store=new BedMeshProfileStore(new BedMeshProfiles(new ConfigurationReader(parseKlipperMainText('','/unused'),null)),session),mesh=new BedMesh({min_x:0,max_x:20,min_y:0,max_y:20,x_count:2,y_count:2,mesh_x_pps:0,mesh_y_pps:0,algo:'direct',tension:.2},[[.1,.2],[.3,.4]]),events:string[][]=[];
store.save('p',mesh);const save=store.save.bind(store),remove=store.remove.bind(store);store.save=(name,m)=>{events.push(['SAVE',name]);save(name,m);};store.remove=name=>{events.push(['REMOVE',name]);return remove(name);};const d=new GCodeDispatch({output(){},shutdown(){}});d.setReady(true);registerBedMeshProfile(d,store,{current:()=>mesh,activate:(_m,name)=>{events.push(['LOAD',name]);}});
for(const params of cases){const command='BED_MESH_PROFILE '+Object.entries(params).map(([k,v])=>`${k}="${v}"`).join(' ');try{await d.execute(command);}catch{events.push(['ERROR']);}}assert.deepEqual(events,ref.events);
const times:number[]=[];for(let i=0;i<16;i++){events.length=0;const start=performance.now();for(let j=0;j<1000;j++)await d.execute('BED_MESH_PROFILE LOAD=p');if(i>=5)times.push(performance.now()-start);}const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};};console.log(JSON.stringify({node:process.version,python:ref.python,cases:cases.length,actionTraceExact:true,loadsPerBatch:1000,nodeTime:stats(times),pythonTime:stats(ref.times),scope:'Original Python command action selection with callback stubs vs Node real dispatcher/store and owned mesh copy with activation stub. Different work; no physical motion drain/activation or speedup claim.'},null,2));
