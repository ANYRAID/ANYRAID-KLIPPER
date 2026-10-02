import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {BedMeshFade} from '../src/motion/bed-mesh-fade.ts';
const cases=Array.from({length:1000},(_,i)=>({start:1,end:10,target:[-.1,0,.1][i%3],toolOffset:[-2,0,3][i%3],z:(i%157)*.1-3,meshZ:(i%23)*.04-.4}));
const source=String.raw`
import sys,ast,json,time
source=ast.parse(open(sys.argv[1]).read());nodes=[n for n in source.body if isinstance(n,ast.ClassDef) and n.name=='BedMesh' or isinstance(n,ast.FunctionDef) and n.name=='constrain'];ns={};exec(compile(ast.Module(body=nodes,type_ignores=[]),sys.argv[1],'exec'),ns)
r=json.load(sys.stdin)
class Mesh:
 def calc_z(self,x,y):return self.z
class Tool:
 def get_position(self):return self.position
objects=[]
for c in r:
 b=ns['BedMesh'].__new__(ns['BedMesh']);b.fade_start=c['start'];b.fade_end=c['end'];b.fade_dist=c['end']-c['start'];b.fade_target=c['target'];b.tool_offset=c['toolOffset'];b.z_mesh=Mesh();b.z_mesh.z=c['meshZ'];b.toolhead=Tool();b.last_position=[0,0,0,0];objects.append(b)
def run(i):
 c=r[i];b=objects[i];factor=b.get_z_factor(c['z']);z=c['z']+(factor*(c['meshZ']-c['target'])+c['target']);b.toolhead.position=[0,0,z,0];return [factor,z,b.get_position()[2]]
results=[run(i) for i in range(len(r))];times=[]
for k in range(16):
 start=time.perf_counter();checksum=0
 for j in range(200000):checksum+=run(j%len(r))[2]
 times.append((time.perf_counter()-start)*1000)
print(json.dumps(dict(results=results,times=times[5:],checksum=checksum,python=sys.version.split()[0])))
`;
const ref=JSON.parse(execFileSync(process.env.PYTHON??'python3',['-c',source,fileURLToPath(new URL('../../klippy/extras/bed_mesh.py',import.meta.url))],{input:JSON.stringify(cases),encoding:'utf8'}));const fades=cases.map(c=>new BedMeshFade(c));let maxError=0,maxRoundtripError=0;
function run(i:number){const c=cases[i],f=fades[i],factor=f.factor(c.z),z=f.apply(c.z,c.meshZ);return [factor,z,f.unapply(z,c.meshZ)];}
for(let i=0;i<cases.length;i++){const values=run(i);maxRoundtripError=Math.max(maxRoundtripError,Math.abs(values[2]-cases[i].z));values.forEach((v,j)=>{const error=Math.abs(v-ref.results[i][j]);maxError=Math.max(maxError,error);assert.ok(error<=1e-12+Math.abs(ref.results[i][j])*1e-12);});}assert.ok(maxRoundtripError<1e-12);
const times:number[]=[];let checksum=0;for(let k=0;k<16;k++){const start=performance.now();checksum=0;for(let j=0;j<200000;j++)checksum+=run(j%cases.length)[2];if(k>=5)times.push(performance.now()-start);}assert.ok(Math.abs(checksum-ref.checksum)<1e-8);const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};};console.log(JSON.stringify({node:process.version,python:ref.python,cases:cases.length,maxError,maxRoundtripError,iterations:200000,nodeTime:stats(times),pythonTime:stats(ref.times),checksumError:Math.abs(checksum-ref.checksum),scope:'Original get_z_factor/get_position via AST; stub mesh/toolhead, forward equation from move/splitter. Includes full Python position list reconstruction; Node returns scalar inverse. Construction/startup/IPC/queue excluded; not hardware timing.'},null,2));
