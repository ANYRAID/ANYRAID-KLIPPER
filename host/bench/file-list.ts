import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp,mkdir,writeFile,utimes,symlink,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {FileListing,type FileListEntry} from '../src/moonraker/file-list.ts';
const source=process.env.MOONRAKER_FILE_MANAGER_SOURCE;if(!source)throw new Error('Set MOONRAKER_FILE_MANAGER_SOURCE to the pinned file_manager.py');
const sha256='a4bc7348613558fe98c282cb9c82b1c8014a3ac48e7223b339bac6f0729b893d';assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'),sha256);
const directory=await mkdtemp(join(tmpdir(),'file-list-bench-')),root=join(directory,'gcodes');let listing:FileListing|undefined;
const python=String.raw`
import ast,sys,json,os,pathlib,logging,time
from typing import *
request=json.load(sys.stdin)
module=ast.parse(pathlib.Path(request['source']).read_text())
original=next(n for n in module.body if isinstance(n,ast.ClassDef) and n.name=='FileManager')
methods=[n for n in original.body if isinstance(n,ast.FunctionDef) and n.name in ('get_file_list','get_path_info','check_reserved_path')]
assert len(methods)==3
node=ast.ClassDef(name='FileManager',bases=[],keywords=[],body=methods,decorator_list=[])
StrOrPath=Union[str,pathlib.Path]
VALID_GCODE_EXTS=['.gcode','.g','.gco','.ufp','.nc']
exec('from __future__ import annotations\n'+ast.unparse(ast.fix_missing_locations(ast.Module(body=[node],type_ignores=[]))),globals())
class Server:
 error=RuntimeError
fm=FileManager();fm.server=Server();fm.file_paths={'gcodes':request['root']};fm.full_access_roots={'gcodes'};fm.reserved_paths={'private':(pathlib.Path(request['root'])/'private',False),'readonly':(pathlib.Path(request['root'])/'readonly.gcode',True)}
samples=[]
for i in range(16):
 start=time.perf_counter();result=fm.get_file_list('gcodes',True);elapsed=(time.perf_counter()-start)*1000
 if i>=5:samples.append(elapsed)
print(json.dumps({'python':sys.version.split()[0],'result':result,'samples':samples}))
`;
try{
 await mkdir(root);
 for(let d=0;d<20;d++){
  const child=join(root,`d${d}`);await mkdir(child);
  for(let f=0;f<50;f++){const path=join(child,`part${f}.gcode`);await writeFile(path,'G1 X1\n');await utimes(path,1700000000,1700000000.125);}
 }
 for(const name of ['Z.g','a.GCODE','readonly.gcode','ignore.txt','\ue000.nc','\u{10000}.nc','İ.gco','Σ.gcode','\u{10d70}.gcode','\u{10d50}.gcode']){const path=join(root,name);await writeFile(path,'G1 X2\n');await utimes(path,-12.25,-12.25);}
 await mkdir(join(root,'private'));await writeFile(join(root,'private','hidden.gcode'),'secret');
 await mkdir(join(root,'.git'));await writeFile(join(root,'.git','hidden.gcode'),'secret');
 await symlink('..',join(root,'d0','loop'));await symlink('d0',join(root,'alias'));await symlink('a.GCODE',join(root,'link.gcode'));await symlink('missing',join(root,'broken.gcode'));
 const reference=spawnSync(process.env.PYTHON??'/usr/bin/python3',['-c',python],{input:JSON.stringify({source,root}),encoding:'utf8',maxBuffer:8*1024**2,timeout:60000});if(reference.status!==0)throw new Error(reference.stderr);
 const oracle=JSON.parse(reference.stdout) as {python:string;result:unknown;samples:number[]};
 listing=await FileListing.open({roots:[{name:'gcodes',path:root,writable:true}],reserved:[{path:join(root,'private'),canRead:false},{path:join(root,'readonly.gcode'),canRead:true}]});
 const delay=monitorEventLoopDelay({resolution:1}),samples:number[]=[];delay.enable();
 for(let run=0;run<16;run++){const begin=performance.now();const result:FileListEntry[]=await listing.list('gcodes',new AbortController().signal);const elapsed=performance.now()-begin;assert.deepEqual(result,oracle.result);if(run>=5)samples.push(elapsed);}
 delay.disable();const stats=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b);return {medianMs:sorted[5],p95Ms:sorted[10]};};
 console.log(JSON.stringify({node:process.version,python:oracle.python,commit:'1cfb0c41e468645951a371621f06d32777b6107c',sourceSHA256:sha256,files:(oracle.result as unknown[]).length,warmups:5,runs:11,nodeWorkerList:stats(samples),pythonOriginalList:stats(oracle.samples),parentEventLoop:{p95Ms:delay.percentile(95)/1e6,maxMs:delay.max/1e6},scope:'Pinned original AST methods on the same actual tree; identical metadata, permissions, Unicode sort, negative mtime, links, cycles and reserved paths. Warm cache, Python samples precede Node; Worker startup excluded. Not a consistent filesystem snapshot, full file manager, or printer timing acceptance.'},null,2));
}finally{await listing?.close();await rm(directory,{recursive:true,force:true});}
