import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp,mkdir,writeFile,utimes,symlink,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {FileListing,registerFileListing,type FileDirectory} from '../src/moonraker/file-list.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher} from '../src/moonraker/rpc.ts';
const source=process.env.MOONRAKER_FILE_MANAGER_SOURCE;if(!source)throw new Error('Set MOONRAKER_FILE_MANAGER_SOURCE');
const sha256='a4bc7348613558fe98c282cb9c82b1c8014a3ac48e7223b339bac6f0729b893d';assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'),sha256);
const directory=await mkdtemp(join(tmpdir(),'directory-bench-')),root=join(directory,'gcodes');let listing:FileListing|undefined;
const metadata={'part0.gcode':{layer_height:0.2,estimated_time:123.45,size:500}};
const python=String.raw`
import ast,sys,json,os,pathlib,logging,time,shutil
from typing import *
request=json.load(sys.stdin);module=ast.parse(pathlib.Path(request['source']).read_text())
original=next(n for n in module.body if isinstance(n,ast.ClassDef) and n.name=='FileManager')
methods=[n for n in original.body if isinstance(n,ast.FunctionDef) and n.name in ('_list_directory','get_path_info','check_reserved_path','get_relative_path')];assert len(methods)==4
node=ast.ClassDef(name='FileManager',bases=[],keywords=[],body=methods,decorator_list=[])
StrOrPath=Union[str,pathlib.Path];VALID_GCODE_EXTS=['.gcode','.g','.gco','.ufp','.nc']
exec('from __future__ import annotations\n'+ast.unparse(ast.fix_missing_locations(ast.Module(body=[node],type_ignores=[]))),globals())
class Server: error=RuntimeError
fm=FileManager();fm.server=Server();fm.file_paths={'gcodes':request['root']};fm.full_access_roots={'gcodes'};fm.reserved_paths={'private':(pathlib.Path(request['root'])/'private',False)};fm.gcode_metadata=request['metadata'];samples=[]
for i in range(16):
 start=time.perf_counter();result=fm._list_directory(request['root'],'gcodes',True);elapsed=(time.perf_counter()-start)*1000
 if i>=5:samples.append(elapsed)
print(json.dumps({'python':sys.version.split()[0],'result':result,'samples':samples}))
`;
try{
 await mkdir(root);for(let i=0;i<1000;i++){const path=join(root,`part${i}.gcode`);await writeFile(path,'G1 X1\n');await utimes(path,1700000000,1700000000.125);}
 for(const name of ['parts','.git','private'])await mkdir(join(root,name));await writeFile(join(root,'README.txt'),'text');await symlink('part0.gcode',join(root,'link.gcode'));await symlink('missing',join(root,'broken'));
 const reference=spawnSync(process.env.PYTHON??'/usr/bin/python3',['-c',python],{input:JSON.stringify({source,root,metadata}),encoding:'utf8',maxBuffer:8*1024**2,timeout:60000});if(reference.status!==0)throw new Error(reference.stderr);
 const oracle=JSON.parse(reference.stdout) as {python:string;result:FileDirectory;samples:number[]};
 listing=await FileListing.open({roots:[{name:'gcodes',path:root,writable:true}],reserved:[{path:join(root,'private'),canRead:false}]});
 const registry=new EndpointRegistry(new JsonRpcDispatcher());registerFileListing(registry,listing,name=>(metadata as Record<string,Record<string,number>>)[name]);
 const delay=monitorEventLoopDelay({resolution:1}),samples:number[]=[];delay.enable();
 for(let run=0;run<16;run++){
  const begin=performance.now(),result=await registry.invoke('/server/files/directory','GET',{extended:true},{transport:'http',signal:new AbortController().signal,authorize(){}}) as unknown as FileDirectory,elapsed=performance.now()-begin;
  const {disk_usage:actual,...items}=result,{disk_usage:expected,...referenceItems}=oracle.result;
  assert.deepEqual(items,referenceItems);assert.equal(actual.total,expected.total);assert.ok(actual.used+actual.free<=actual.total);if(run>=5)samples.push(elapsed);
 }
 delay.disable();const stats=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b);return {medianMs:sorted[5],p95Ms:sorted[10]};};
 console.log(JSON.stringify({node:process.version,python:oracle.python,commit:'1cfb0c41e468645951a371621f06d32777b6107c',sourceSHA256:sha256,files:oracle.result.files.length,dirs:oracle.result.dirs.length,warmups:5,runs:11,nodeWorkerAndEndpoint:stats(samples),pythonOriginalDirectory:stats(oracle.samples),parentEventLoop:{p95Ms:delay.percentile(95)/1e6,maxMs:delay.max/1e6},scope:'Pinned original directory/path metadata methods; same live filesystem and extended metadata. Node includes Worker round-trip, endpoint validation and merge; disk total exact, changing used/free checked by invariants. Cached, Python first, startup excluded; not printer acceptance.'},null,2));
}finally{await listing?.close();await rm(directory,{recursive:true,force:true});}
