import {meshReference} from './mesh-reference.ts';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {requestMeshDump} from '../src/diagnostics/mesh-source.ts';
const fixture={current_mesh:{name:'bench',probed_matrix:Array.from({length:8},(_,r)=>Array.from({length:8},(_,c)=>(r+c)/100)),mesh_params:{min_x:0,max_x:200,min_y:0,max_y:200}},profiles:{},calibration:{points:[[0,0]],probe_path:[[0,0]],rapid_path:[[[0,0],true]]}};
const dir=await mkdtemp(join(tmpdir(),'mesh-source-bench-')),path=join(dir,'socket'),response=JSON.stringify({id:1,result:fixture})+'\x03',server=createServer(socket=>{socket.on('error',()=>{});socket.once('data',()=>socket.end(response));});

try{await new Promise<void>(r=>server.listen(path,r));const ref=meshReference('source',fixture);assert.deepEqual(ref.result,fixture);const samples:number[]=[];for(let i=0;i<16;i++){const at=performance.now(),result=await requestMeshDump(path,new AbortController().signal);if(i>=5)samples.push(performance.now()-at);assert.deepEqual(result,fixture);}const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};};console.log(JSON.stringify({node:process.version,referencePython:ref.python,responseBytes:Buffer.byteLength(response),warmups:5,runs:11,nodeAcquisition:stats(samples),historicalPythonAcquisition:stats(ref.samples),scope:'Reference outputs and Python/NumPy timing are historical captures; this run does not execute Python. Local Unix socket request/response, decode and close initiation; Node includes stat and admission. Original Python function logs to StringIO. Startup/imports/server setup excluded; no physical printer or network latency claim.'},null,2));}finally{await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
