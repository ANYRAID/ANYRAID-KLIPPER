import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {loadConfiguration} from '../src/moonraker/config-source.ts';
import {BedMeshProfiles} from '../src/motion/bed-mesh-profiles.ts';
const records=Array.from({length:16},(_,i)=>({name:`bed_mesh profile${i}`,version:1,min_x:0,max_x:220,min_y:0,max_y:300,x_count:5,y_count:5,mesh_x_pps:2,mesh_y_pps:2,algo:'bicubic',tension:.2,points:Array.from({length:5},(_,y)=>Array.from({length:5},(_,x)=>Math.sin(x+i)*.1+Math.cos(y)*.2))}));
const py=String.raw`
import ast,sys,json,math,logging,collections,types,time
r=json.load(sys.stdin);tree=ast.parse(open(sys.argv[1]).read());ns=dict(math=math,logging=logging,collections=collections,PROFILE_VERSION=1,PROFILE_OPTIONS=dict(min_x=float,max_x=float,min_y=float,max_y=float,x_count=int,y_count=int,mesh_x_pps=int,mesh_y_pps=int,algo=str,tension=float),BedMeshError=RuntimeError)
names=['ProfileManager','ZMesh','lerp','constrain'];exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,(ast.ClassDef,ast.FunctionDef)) and n.name in names],type_ignores=[]),sys.argv[1],'exec'),ns);ns['ZMesh'].print_mesh=lambda *a:None
class Section:
 def __init__(self,r):self.r=r
 def get_name(self):return self.r['name']
 def getint(self,k,default=None):return int(self.r.get(k,default))
 def getfloat(self,k):return float(self.r[k])
 def get(self,k):return self.r[k]
 def getlists(self,*a,**kw):return [list(row) for row in self.r['points']]
class Config:
 def get_name(self):return 'bed_mesh'
 def get_printer(self):return types.SimpleNamespace(lookup_object=lambda n:types.SimpleNamespace(register_command=lambda *a,**kw:None,error=RuntimeError))
 def get_prefix_sections(self,n):return [Section(c) for c in r]
def run():
 out=[];bed=types.SimpleNamespace(set_mesh=lambda m:out.append([v for row in m.mesh_matrix for v in row]));p=ns['ProfileManager'](Config(),bed)
 for c in r:p.load_profile(c['name'][9:])
 return out
result=run();times=[]
for i in range(16):
 start=time.perf_counter()
 for j in range(20):run()
 times.append((time.perf_counter()-start)*1000)
print(json.dumps(dict(result=result,times=times[5:],python=sys.version.split()[0])))
`;
const ref=JSON.parse(execFileSync(process.env.PYTHON??'python3',['-c',py,fileURLToPath(new URL('../../klippy/extras/bed_mesh.py',import.meta.url))],{input:JSON.stringify(records),encoding:'utf8'}));
const dir=await mkdtemp(join(tmpdir(),'profile-bench-'));try{const path=join(dir,'printer.cfg');await writeFile(path,records.map(r=>`[${r.name}]\n`+Object.entries(r).filter(([k])=>k!=='name').map(([k,v])=>`${k}: ${k==='points'?'\n '+r.points.map(row=>row.join(', ')).join('\n '):v}`).join('\n')).join('\n\n'));const source=await loadConfiguration(path,{},null);function run(){const p=new BedMeshProfiles(new ConfigurationReader(source,null));return p.names.map(n=>Array.from(p.load(n).meshValues()));}const result=run();assert.equal(result.length,ref.result.length);let maxError=0;result.forEach((r,i)=>r.forEach((v,j)=>{maxError=Math.max(maxError,Math.abs(v-ref.result[i][j]));assert.ok(Math.abs(v-ref.result[i][j])<1e-12);}));const times:number[]=[];for(let i=0;i<16;i++){const start=performance.now();for(let j=0;j<20;j++)run();if(i>=5)times.push(performance.now()-start);}const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};};console.log(JSON.stringify({node:process.version,python:ref.python,profiles:16,loadsPerBatch:320,maxError,nodeTime:stats(times),pythonTime:stats(ref.times),scope:'Original ProfileManager construction/load_profile and ZMesh; Python Config stub supplies typed records, Node uses ConfigSection conversions. Includes build, independent loads and grid copies. File I/O and hardware excluded; not equal parser work.'},null,2));}finally{await rm(dir,{recursive:true,force:true});}
