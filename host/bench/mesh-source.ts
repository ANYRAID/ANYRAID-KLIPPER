import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:net';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {requestMeshDump} from '../src/diagnostics/mesh-source.ts';
const fixture={current_mesh:{name:'bench',probed_matrix:Array.from({length:8},(_,r)=>Array.from({length:8},(_,c)=>(r+c)/100)),mesh_params:{min_x:0,max_x:200,min_y:0,max_y:200}},profiles:{},calibration:{points:[[0,0]],probe_path:[[0,0]],rapid_path:[[[0,0],true]]}};
const dir=await mkdtemp(join(tmpdir(),'mesh-source-bench-')),path=join(dir,'socket'),response=JSON.stringify({id:1,result:fixture})+'\x03',server=createServer(socket=>{socket.on('error',()=>{});socket.once('data',()=>socket.end(response));});
const source=String.raw`
import sys,runpy,io,time,json
fn=runpy.run_path(sys.argv[1])['request_from_unixsocket'];saved=sys.stdout;sys.stdout=io.StringIO();samples=[]
for i in range(16):
 start=time.perf_counter();result=fn(sys.argv[2]);samples.append((time.perf_counter()-start)*1000)
sys.stdout=saved;print(json.dumps(dict(samples=samples[5:],result=result,python=sys.version.split()[0])))
`;
try{await new Promise<void>(r=>server.listen(path,r));const ref=JSON.parse((await promisify(execFile)(process.env.PYTHON??'python3',['-c',source,fileURLToPath(new URL('../../scripts/graph_mesh.py',import.meta.url)),path],{maxBuffer:1024**2})).stdout);assert.deepEqual(ref.result,fixture);const samples:number[]=[];for(let i=0;i<16;i++){const at=performance.now(),result=await requestMeshDump(path,new AbortController().signal);if(i>=5)samples.push(performance.now()-at);assert.deepEqual(result,fixture);}const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};};console.log(JSON.stringify({node:process.version,python:ref.python,responseBytes:Buffer.byteLength(response),warmups:5,runs:11,nodeAcquisition:stats(samples),pythonAcquisition:stats(ref.samples),scope:'Local Unix socket request/response, decode and close initiation; Node includes stat and admission. Original Python function logs to StringIO. Startup/imports/server setup excluded; no physical printer or network latency claim.'},null,2));}finally{await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
