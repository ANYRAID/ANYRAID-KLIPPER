import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {BedMesh,type BedMeshParameters} from '../src/motion/bed-mesh.ts';
const cases=([['direct',3,4,0,0,.2],['lagrange',3,5,2,3,.2],['bicubic',4,4,3,2,.2],['bicubic',7,9,2,2,.2],['bicubic',4,5,0,3,0],['bicubic',5,4,2,0,2]] as const).map(([algo,x_count,y_count,mesh_x_pps,mesh_y_pps,tension])=>({params:{algo,x_count,y_count,mesh_x_pps,mesh_y_pps,tension,min_x:-10,max_x:210,min_y:5,max_y:305},matrix:Array.from({length:y_count},(_,y)=>Array.from({length:x_count},(_,x)=>Math.sin(x*.7)*.3+Math.cos(y*.4)*.2))}));
const queries=Array.from({length:1000},(_,i)=>[(i%997)*.31-40,((i*17)%991)*.41-50]);
const source=String.raw`
import sys,json,ast,math,logging,time
source=ast.parse(open(sys.argv[1]).read());nodes=[n for n in source.body if isinstance(n,ast.ClassDef) and n.name=='ZMesh' or isinstance(n,ast.FunctionDef) and n.name in ['constrain','lerp']];ns=dict(math=math,logging=logging,BedMeshError=RuntimeError);exec(compile(ast.Module(body=nodes,type_ignores=[]),sys.argv[1],'exec'),ns);ZMesh=ns['ZMesh'];ZMesh.print_mesh=lambda *a:None
request=json.load(sys.stdin);results=[]
def create(case):
 m=ZMesh(case['params'],'benchmark');m.build_mesh([list(row) for row in case['matrix']]);return m
for case in request['cases']:
 m=create(case);values=[m.calc_z(x,y) for x,y in request['queries']];mesh=[v for row in m.mesh_matrix for v in row];m.set_mesh_offsets([.125,-.375]);offset_values=[m.calc_z(x,y) for x,y in request['queries']];offset=m.calc_z(30,40);m.set_zero_reference(30,40);results.append(dict(mesh=mesh,values=values,offsetValues=offset_values,zeroOffset=offset,zeroValues=[m.calc_z(x,y) for x,y in request['queries']]))
build=[];lookup=[]
for i in range(16):
 start=time.perf_counter();m=create(request['cases'][3]);build.append((time.perf_counter()-start)*1000);start=time.perf_counter();checksum=0
 for j in range(200000):checksum+=m.calc_z((j%997)*.31-40,((j*17)%991)*.41-50)
 lookup.append((time.perf_counter()-start)*1000)
print(json.dumps(dict(results=results,build=build[5:],lookup=lookup[5:],checksum=checksum,python=sys.version.split()[0])))
`;
const ref=JSON.parse(execFileSync(process.env.PYTHON??'python3',['-c',source,fileURLToPath(new URL('../../klippy/extras/bed_mesh.py',import.meta.url))],{input:JSON.stringify({cases,queries}),encoding:'utf8',maxBuffer:8*1024**2}));let maxError=0;const check=(a:number,b:number)=>{maxError=Math.max(maxError,Math.abs(a-b));assert.ok(Math.abs(a-b)<=1e-12+Math.abs(b)*1e-12,`${a} != ${b}`);};for(let k=0;k<cases.length;k++){const c=cases[k],m=new BedMesh(c.params as BedMeshParameters,c.matrix),expected=ref.results[k];assert.equal(m.meshValues().length,expected.mesh.length);m.meshValues().forEach((v,i)=>check(v,expected.mesh[i]));queries.forEach(([x,y],i)=>check(m.calcZ(x,y),expected.values[i]));m.setOffsets(.125,-.375);queries.forEach(([x,y],i)=>check(m.calcZ(x,y),expected.offsetValues[i]));m.setZeroReference(30,40);queries.forEach(([x,y],i)=>check(m.calcZ(x,y),expected.zeroValues[i]+(c.params.algo==='direct'?expected.zeroOffset:0)));}
const builds:number[]=[],lookups:number[]=[];let checksum=0;for(let i=0;i<16;i++){let at=performance.now();const m=new BedMesh(cases[3].params as BedMeshParameters,cases[3].matrix);if(i>=5)builds.push(performance.now()-at);at=performance.now();checksum=0;for(let j=0;j<200000;j++)checksum+=m.calcZ((j%997)*.31-40,((j*17)%991)*.41-50);if(i>=5)lookups.push(performance.now()-at);}assert.ok(Math.abs(checksum-ref.checksum)<1e-8);const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};};console.log(JSON.stringify({node:process.version,python:ref.python,cases:cases.length,queriesPerCase:1000,maxError,nodeBuild:stats(builds),pythonBuild:stats(ref.build),hotLookups:200000,nodeLookup:stats(lookups),pythonLookup:stats(ref.lookup),checksumError:Math.abs(checksum-ref.checksum),scope:'Original AST-extracted ZMesh and helpers, unmodified numerical methods; print_mesh disabled for compute timing. Direct zero-reference legacy double-subtraction explicitly corrected in comparison. Startup/IPC excluded; no hardware timing claim.'},null,2));
