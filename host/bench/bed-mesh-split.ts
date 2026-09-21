import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {BedMesh} from '../src/motion/bed-mesh.ts';
import {splitBedMeshMove} from '../src/motion/bed-mesh-split.ts';
const params={algo:'bicubic' as const,x_count:7,y_count:9,mesh_x_pps:2,mesh_y_pps:2,tension:.2,min_x:0,max_x:220,min_y:0,max_y:300};
const matrix=Array.from({length:9},(_,y)=>Array.from({length:7},(_,x)=>Math.sin(x*.7)*.3+Math.cos(y*.4)*.2));
const moves=Array.from({length:240},(_,i)=>({start:[(i*31)%260-20,(i*17)%340-20,i%7,i*.4],end:[(i*67)%260-20,(i*53)%340-20,(i+3)%7,-i*.2],options:{factor:[0,.125,.5,1][i%4],fadeOffset:[0,.1,-.2][i%3],splitDeltaZ:[.01,.025,.1][i%3],checkDistance:[3,5,7.5][i%3]}}));
for(const end of [[0,0,0,0],[0,0,5,0],[0,0,0,100],[20,1e-11,0,5e-11],[6,0,8,2]])moves.push({start:[0,0,0,0],end,options:{factor:1,fadeOffset:0,splitDeltaZ:.025,checkDistance:5}});
const source=String.raw`
import sys,json,ast,math,logging,time
source=ast.parse(open(sys.argv[1]).read());nodes=[n for n in source.body if isinstance(n,ast.ClassDef) and n.name in ['ZMesh','MoveSplitter'] or isinstance(n,ast.FunctionDef) and n.name in ['constrain','lerp','isclose']];ns=dict(math=math,logging=logging,BedMeshError=RuntimeError);exec(compile(ast.Module(body=nodes,type_ignores=[]),sys.argv[1],'exec'),ns);ns['ZMesh'].print_mesh=lambda *a:None
r=json.load(sys.stdin);mesh=ns['ZMesh'](r['params'],'benchmark');mesh.build_mesh(r['matrix'])
class Config:
 def getfloat(self,name,default,**kwargs):return default
class Gcode:
 error=RuntimeError
splitter=ns['MoveSplitter'](Config(),Gcode())
def run(move):
 o=move['options'];splitter.split_delta_z=o['splitDeltaZ'];splitter.move_check_distance=o['checkDistance'];splitter.initialize(mesh,o['fadeOffset']);splitter.build_move(move['start'],move['end'],o['factor']);out=[]
 while True:
  segment=splitter.split()
  if segment is None:break
  out.append(segment)
 return out
results=[run(m) for m in r['moves']];times=[]
for i in range(16):
 start=time.perf_counter();checksum=0;count=0
 for j in range(10000):
  segments=run(r['moves'][j%len(r['moves'])]);count+=len(segments);checksum+=sum(p[2] for p in segments)
 times.append((time.perf_counter()-start)*1000)
print(json.dumps(dict(results=results,times=times[5:],checksum=checksum,count=count,python=sys.version.split()[0])))
`;
const ref=JSON.parse(execFileSync(process.env.PYTHON??'python3',['-c',source,fileURLToPath(new URL('../../klippy/extras/bed_mesh.py',import.meta.url))],{input:JSON.stringify({params,matrix,moves}),encoding:'utf8',maxBuffer:8*1024**2}));
const mesh=new BedMesh(params,matrix);let maxError=0,comparedSegments=0;
for(let i=0;i<moves.length;i++){const m=moves[i],actual=splitBedMeshMove(mesh,m.start,m.end,m.options),expected=ref.results[i];assert.equal(actual.length,expected.length,`segment count ${i}`);comparedSegments+=actual.length;actual.forEach((p,j)=>p.forEach((v,k)=>{const error=Math.abs(v-expected[j][k]);maxError=Math.max(maxError,error);assert.ok(error<=1e-12+Math.abs(expected[j][k])*1e-12,`move ${i} segment ${j} axis ${k}`);}));}
const times:number[]=[];let checksum=0,count=0;for(let i=0;i<16;i++){const start=performance.now();checksum=0;count=0;for(let j=0;j<10000;j++){const m=moves[j%moves.length],segments=splitBedMeshMove(mesh,m.start,m.end,m.options);count+=segments.length;let sum=0;for(const p of segments)sum+=p[2];checksum+=sum;}if(i>=5)times.push(performance.now()-start);}assert.equal(count,ref.count);assert.ok(Math.abs(checksum-ref.checksum)<1e-8);
const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[5],p95Ms:values[10]};};console.log(JSON.stringify({node:process.version,python:ref.python,cases:moves.length,comparedSegments,maxError,movesPerBatch:10000,segmentsPerBatch:count,checksumError:Math.abs(checksum-ref.checksum),nodeTime:stats(times),pythonTime:stats(ref.times),scope:'Original AST-extracted MoveSplitter and ZMesh numerical methods; complete segment arrays materialized on both sides. Python splitter reused; Node input validation included. Mesh construction, startup, IPC and motion queue excluded. No hardware or print-speed acceptance.'},null,2));
