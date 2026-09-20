import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp,writeFile,open,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {readMetadataWindow,METADATA_READ_BYTES as R} from '../src/moonraker/metadata-window.ts';
const source=process.env.MOONRAKER_METADATA_SOURCE;if(!source)throw new Error('Set MOONRAKER_METADATA_SOURCE to pinned metadata.py');
const sha256='ae2488ff23e6ddcaf961b063506dad1a7141b38b92102bc174422ed244641d2e';assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'),sha256);
const directory=await mkdtemp(join(tmpdir(),'metadata-window-bench-'));
const data=[Buffer.alloc(0),Buffer.from('\ufeff;零件😀\nG1 X1\n'),Buffer.alloc(R,65),Buffer.alloc(R+20,66),Buffer.alloc(2*R,67),Buffer.from('G1 X1 Y2 E3\n'.repeat(300000)),Buffer.from('😀'+'H'.repeat(R-4)+'gap'+'T'.repeat(R)),Buffer.concat([Buffer.alloc(R-1,65),Buffer.from('中'),Buffer.alloc(32,66)]),Buffer.from('a\xff'.repeat(R),'latin1')];
const python=String.raw`
import ast,sys,json,os,time,hashlib
from typing import *
request=json.load(sys.stdin);module=ast.parse(open(request['source']).read());classes=[n for n in module.body if isinstance(n,ast.ClassDef) and n.name in ('SlicerType','BaseSlicer','UnknownSlicer')]
READ_SIZE=1024*1024
exec('from __future__ import annotations\n'+ast.unparse(ast.Module(body=classes,type_ignores=[])),globals())
def info(path):
 s=BaseSlicer.from_file(path)
 return {'size':s.size,'hashes':[hashlib.sha256(v.encode()).hexdigest() for v in (s._file_data,s.header_data,s.footer_data)]}
results=[info(path) for path in request['paths']];samples=[[],[]]
for run in range(16):
 for variant,index in enumerate([5,8]):
  start=time.perf_counter();BaseSlicer.from_file(request['paths'][index]);elapsed=(time.perf_counter()-start)*1000
  if run>=5:samples[variant].append(elapsed)
print(json.dumps({'python':sys.version.split()[0],'results':results,'samples':samples}))
`;
try{
 const paths:string[]=[];for(let i=0;i<data.length;i++){const path=join(directory,String(i));await writeFile(path,data[i]);paths.push(path);}
 const result=spawnSync(process.env.PYTHON??'/usr/bin/python3',['-c',python],{input:JSON.stringify({source,paths}),encoding:'utf8',timeout:60000});if(result.status!==0)throw new Error(result.stderr);
 const oracle=JSON.parse(result.stdout),fingerprint=(value:string)=>createHash('sha256').update(value).digest('hex');
 for(let i=0;i<paths.length;i++){const file=await open(paths[i],'r');try{const window=await readMetadataWindow(file,new AbortController().signal);assert.deepEqual({size:window.size,hashes:[window.data,window.header,window.footer].map(fingerprint)},oracle.results[i]);}finally{await file.close();}}
 const samples:number[][]=[[],[]];
 for(let run=0;run<16;run++)for(const [variant,index] of [5,8].entries()){
  const begin=performance.now(),file=await open(paths[index],'r');try{await readMetadataWindow(file,new AbortController().signal);}finally{await file.close();}if(run>=5)samples[variant].push(performance.now()-begin);
 }
 const stats=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b);return {medianMs:sorted[5],p95Ms:sorted[10]};};
 console.log(JSON.stringify({node:process.version,python:oracle.python,commit:'1cfb0c41e468645951a371621f06d32777b6107c',sourceSHA256:sha256,fixtures:data.length,warmups:5,runs:11,variants:['validAsciiLarge','alternatingInvalidUtf8'],bytes:[data[5].length,data[8].length],nodeWindow:samples.map(stats),pythonFromFile:oracle.samples.map(stats),scope:'Pinned BaseSlicer.from_file/constructor with empty registered slicer set: actual byte reads, ignore decoding and codepoint slicing only. Node includes open/close, two source-stat checks and cancellation; hashes verified outside timings. Warm tmp files, Python first. No identification, parsers, image processing or print throughput acceptance.'},null,2));
}finally{await rm(directory,{recursive:true,force:true});}
