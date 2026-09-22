import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {performance} from 'node:perf_hooks';
import {runAr100Flash} from '../src/diagnostics/flash-ar100-cli.ts';
const source=execFileSync('git',['show','9f30c114:scripts/flash-ar100.py'],{encoding:'utf8'});assert.equal(createHash('sha256').update(source).digest('hex'),'3ff3d64d70a84335db8790530c443c89326eca661ef27649c456c6c6e9aeaee7');
const native=createRequire(import.meta.url)('../build/ar100-flash-test.node') as {executeTest:(mode:string,data:Buffer,fd:number,fault:string)=>void},dir=await mkdtemp(join(tmpdir(),'ar100-bench-')),file=await open(join(dir,'memory'),'wx+'),operations=100,signal=new AbortController().signal;
const code=String.raw`import sys,json,ast,builtins,time,contextlib,io,mmap
v=json.load(sys.stdin); path=v['directory']; tree=ast.parse(v['source']); tree.body=[n for n in tree.body if isinstance(n,(ast.Import,ast.ImportFrom,ast.FunctionDef)) or isinstance(n,ast.Assign) and all(isinstance(t,ast.Name) and t.id.isupper() for t in n.targets)]
ns={};exec(compile(tree,'retired-flash-ar100.py','exec'),ns)
original=builtins.open
def mapped(p,mode='r',*a,**kw):
    return original(path+'/memory','r+b') if str(p)=='/dev/mem' else original(p,mode,*a,**kw)
builtins.open=mapped
results={}
with contextlib.redirect_stdout(io.StringIO()):
    for size in [4096,65536]:
        timings=[]
        for run in range(9):
            start=time.perf_counter()
            for i in range(v['operations']):
                ns['assert_deassert_reset'](1);ns['write_exception_vectors']();ns['write_file'](path+'/'+str(size));ns['assert_deassert_reset'](0)
            if run>=2: timings.append((time.perf_counter()-start)*1000)
        results[str(size)]=timings
print(json.dumps(results))`;
try{await file.truncate(0x1f02000);for(const size of [4096,65536])await writeFile(join(dir,String(size)),Buffer.alloc(size,0x5a));const python=JSON.parse(execFileSync(process.env.PYTHON??'python3',['-c',code],{input:JSON.stringify({source,directory:dir,operations}),encoding:'utf8',timeout:60000})),results=[];
 for(const size of [4096,65536]){const times:number[]=[];for(let run=0;run<9;run++){const started=performance.now();for(let i=0;i<operations;i++)await runAr100Flash([join(dir,String(size))],signal,()=>{},(mode,data)=>native.executeTest(mode,data,file.fd,''));if(run>=2)times.push(performance.now()-started);}const actual=Buffer.alloc(size);await file.read(actual,0,size,0x44000);assert.deepEqual(actual,Buffer.alloc(size,0x5a));const stats=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[3],p95Ms:v[6]};};results.push({size,node:stats(times),python:stats(python[size])});}
 console.log(JSON.stringify({node:process.version,operations,warmups:2,runs:7,results,scope:'Normal flash of file-backed MMIO image, no /dev/mem access. Node includes async validated firmware read and native readback; original Python has neither readback nor exclusive lock. Excludes process startup, production A64 guard, real MMIO latency and print throughput. Python reference loaded from pinned Git history only.'},null,2));
}finally{await file.close();await rm(dir,{recursive:true,force:true});}
