import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {FileMetadataStore} from '../src/moonraker/file-metadata.ts';
import type {Json} from '../src/moonraker/rpc.ts';
const source=process.env.MOONRAKER_FILE_MANAGER_SOURCE;if(!source)throw new Error('Set MOONRAKER_FILE_MANAGER_SOURCE');
const sha256='a4bc7348613558fe98c282cb9c82b1c8014a3ac48e7223b339bac6f0729b893d';assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'),sha256);
const entries=['part.gcode','folder/sub/part.gcode','零件.gcode'].map<{filename:string;value:Record<string,Json>}>(filename=>({filename,value:{estimated_time:123.125,filament_total:20.5,filename:'stored-placeholder',thumbnails:[{relative_path:'../.thumbs/a.png',width:256,height:128,size:1000},{relative_path:'/shared/b.png',width:64,height:64},{relative_path:null,thumbnail_path:'kept'},{width:32}] as Json[]}}));
const python=String.raw`
import ast,sys,json,pathlib,time,asyncio
from typing import *
from copy import deepcopy
request=json.load(sys.stdin);module=ast.parse(pathlib.Path(request['source']).read_text());classes=[]
for classname,names in [('FileManager',('_handle_metadata_request','_handle_list_thumbs')),('MetadataStorage',('get',))]:
 original=next(n for n in module.body if isinstance(n,ast.ClassDef) and n.name==classname)
 methods=[n for n in original.body if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name in names];assert len(methods)==len(names)
 classes.append(ast.ClassDef(name=classname,bases=[],keywords=[],body=methods,decorator_list=[]))
exec('from __future__ import annotations\n'+ast.unparse(ast.fix_missing_locations(ast.Module(body=classes,type_ignores=[]))),globals())
class Request:
 def __init__(self,name):self.name=name
 def get_str(self,_):return self.name
class Error(Exception):
 def __init__(self,message,status_code=400):super().__init__(message);self.status_code=status_code
class Server:error=Error
fm=FileManager();fm.server=Server();fm.gcode_metadata=MetadataStorage();fm.gcode_metadata.metadata={e['filename']:e['value'] for e in request['entries']}
async def main():
 results=[]
 for entry in request['entries']:
  req=Request(entry['filename']);results.append([await fm._handle_metadata_request(req),await fm._handle_list_thumbs(req)])
 samples=[[],[]];req=Request(request['entries'][1]['filename']);checksum=0
 for run in range(16):
  for variant in (0,1):
   start=time.perf_counter()
   for i in range(5000):
    value=await (fm._handle_metadata_request(req) if variant==0 else fm._handle_list_thumbs(req));checksum+=len(json.dumps(value,ensure_ascii=False,separators=(',',':')).encode())
   if run>=5:samples[variant].append((time.perf_counter()-start)*1000)
 print(json.dumps({'python':sys.version.split()[0],'results':results,'samples':samples,'checksum':checksum}))
asyncio.run(main())
`;
const ref=spawnSync(process.env.PYTHON??'/usr/bin/python3',['-c',python],{input:JSON.stringify({source,entries}),encoding:'utf8',maxBuffer:4*1024**2,timeout:60000});if(ref.status!==0)throw new Error(ref.stderr);
const oracle=JSON.parse(ref.stdout),store=new FileMetadataStore();for(const entry of entries)store.commit(store.begin(entry.filename),entry.value);
assert.deepEqual(entries.map(entry=>[store.metadata(entry.filename),store.thumbnails(entry.filename)]),oracle.results);
const samples:number[][]=[[],[]];let checksum=0;
for(let run=0;run<16;run++)for(const variant of [0,1]){
 const begin=performance.now();for(let i=0;i<5000;i++){const value=variant?store.thumbnails(entries[1].filename):store.metadata(entries[1].filename);checksum+=Buffer.byteLength(JSON.stringify(value));}
 if(run>=5)samples[variant].push(performance.now()-begin);
}
assert.equal(checksum,oracle.checksum);const stats=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b);return {medianMs:sorted[5],p95Ms:sorted[10]};};
console.log(JSON.stringify({node:process.version,python:oracle.python,commit:'1cfb0c41e468645951a371621f06d32777b6107c',sourceSHA256:sha256,fixtures:entries.length,warmups:5,runs:11,requestsPerSample:5000,variants:['metadata','thumbnails'],nodeQueries:samples.map(stats),pythonOriginal:oracle.samples.map(stats),scope:'Original pinned handlers plus MetadataStorage.get deepcopy versus bounded immutable cache responses. Matching fields and lexical thumbnail paths; CPU cache queries including Node JSON.stringify / Python standard json encoding. Not upstream msgspec transport throughput; no network, extraction or filesystem.'},null,2));
