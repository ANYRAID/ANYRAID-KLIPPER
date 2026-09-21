import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {loadKlipperConfiguration} from '../src/config/klipper-files.ts';
import {AUTOSAVE_HEADER} from '../src/config/klipper-autosave.ts';
const dir=await mkdtemp(join(tmpdir(),'klipper-load-bench-'));try{await mkdir(join(dir,'parts'));for(let i=0;i<16;i++)await writeFile(join(dir,'parts',`${String(i).padStart(2,'0')}.cfg`),`[shared]\nvalue: ${i}\n[part ${i}]\npoints:\n  .1,.2\n  .3,.4\n`);const path=join(dir,'printer.cfg');await writeFile(path,'[printer]\nkinematics: cartesian\n[include parts/[0-9]?.cfg]\n[include absent*.cfg]\n[include parts/00.cfg]\n[shared]\nfinal: root\n'+AUTOSAVE_HEADER+'#*# [shared]\n#*# value: saved\n#*# calibration: .125\n');const py=String.raw`
import sys,ast,glob,os,json,re,logging,configparser,io,time,types
ns=dict(sys=sys,glob=glob,os=os,re=re,logging=logging,configparser=configparser,io=io,error=RuntimeError);tree=ast.parse(open(sys.argv[1]).read());nodes=[n for n in tree.body if isinstance(n,ast.ClassDef) and n.name in ['ConfigAutoSave','ConfigFileReader'] or isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='AUTOSAVE_HEADER' for t in n.targets)];exec(compile(ast.Module(body=nodes,type_ignores=[]),sys.argv[1],'exec'),ns);a=ns['ConfigAutoSave'].__new__(ns['ConfigAutoSave']);a.printer=types.SimpleNamespace(get_start_args=lambda:dict(config_file=sys.argv[2]))
def run():
 config,_=a.load_main_config();return dict(DEFAULT=dict(config.defaults()),**{s:dict(config.items(s)) for s in config.sections()})
result=run();times=[]
for i in range(16):
 start=time.perf_counter();run();times.append((time.perf_counter()-start)*1000)
print(json.dumps(dict(result=result,times=times[5:],python=sys.version.split()[0])))
`;const ref=JSON.parse(execFileSync(process.env.PYTHON??'python3',['-c',py,fileURLToPath(new URL('../../klippy/configfile.py',import.meta.url)),path],{encoding:'utf8'}));const actual=await loadKlipperConfiguration(path);assert.deepEqual(JSON.parse(JSON.stringify(actual.original)),ref.result);const times:number[]=[];for(let i=0;i<16;i++){const start=performance.now();await loadKlipperConfiguration(path);if(i>=5)times.push(performance.now()-start);}const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};};console.log(JSON.stringify({node:process.version,python:ref.python,files:actual.files.length,sections:Object.keys(actual.original).length-1,exact:true,nodeTime:stats(times),pythonTime:stats(ref.times),scope:'Original load_main_config with real file reads, glob includes, repeated include and autosave merging. Warm cache, 5 warmup/11 measured loads; Node async bounded I/O vs Python sync I/O. Startup/writes/hardware excluded.'},null,2));}finally{await rm(dir,{recursive:true,force:true});}
