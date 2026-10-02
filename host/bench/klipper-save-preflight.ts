import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {buildKlipperSave} from '../src/config/klipper-save.ts';
import {prepareKlipperSave,revalidateKlipperSave} from '../src/config/klipper-save-preflight.ts';
const dir=await mkdtemp(join(tmpdir(),'save-check-bench-'));try{const path=join(dir,'printer.cfg'),current='[x]\na: old\n[include extra.cfg]\n';await writeFile(path,current);const saved={x:{a:'new'}},candidate=buildKlipperSave(current,saved)!;const children=['[y]\nb: keep\n','[x]\na: new\n','[DEFAULT]\na: new\n[x]\nb: 1\n'];
const py=String.raw`
import sys,ast,json,re,logging,configparser,io,glob,os,types,time
r=json.load(sys.stdin);ns=dict(sys=sys,re=re,logging=logging,configparser=configparser,io=io,glob=glob,os=os,error=RuntimeError);tree=ast.parse(open(sys.argv[1]).read());exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,ast.ClassDef) and n.name in ['ConfigAutoSave','ConfigFileReader']],type_ignores=[]),sys.argv[1],'exec'),ns);reader=ns['ConfigFileReader']();a=ns['ConfigAutoSave'].__new__(ns['ConfigAutoSave']);a.printer=types.SimpleNamespace(command_error=RuntimeError);a.fileconfig=reader.build_fileconfig(r['autosave'],'saved')
def run():
 regular=reader.build_fileconfig_with_includes(r['regular'],sys.argv[2]);a._disallow_include_conflicts(regular)
try:run();accepted=True
except RuntimeError:accepted=False
times=[]
if accepted:
 for i in range(16):
  start=time.perf_counter()
  for j in range(100):run()
  times.append((time.perf_counter()-start)*1000)
print(json.dumps(dict(accepted=accepted,times=times[5:],python=sys.version.split()[0])))
`;
let reference:any;for(let i=0;i<children.length;i++){await writeFile(join(dir,'extra.cfg'),children[i]);const result=JSON.parse(execFileSync(process.env.PYTHON??'python3',['-c',py,fileURLToPath(new URL('../../klippy/configfile.py',import.meta.url)),path],{input:JSON.stringify(candidate),encoding:'utf8'}));let accepted=true;try{await prepareKlipperSave(path,current,saved);}catch{accepted=false;}assert.equal(accepted,result.accepted);assert.equal(accepted,i===0);if(i===0)reference=result;}
await writeFile(join(dir,'extra.cfg'),children[0]);const times:number[]=[];for(let i=0;i<16;i++){const start=performance.now();for(let j=0;j<100;j++)await prepareKlipperSave(path,current,saved);if(i>=5)times.push(performance.now()-start);}const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};};const prepared=(await prepareKlipperSave(path,current,saved))!,verification:number[]=[];for(let i=0;i<16;i++){const start=performance.now();for(let j=0;j<100;j++)await revalidateKlipperSave(prepared);if(i>=5)verification.push(performance.now()-start);}console.log(JSON.stringify({nodeRevalidation:stats(verification),node:process.version,python:reference.python,acceptanceCases:3,exact:true,preflightsPerBatch:100,nodeTime:stats(times),pythonTime:stats(reference.times),scope:'Original include expansion and _disallow_include_conflicts. Node additionally builds/reparses candidate, checks original main text and returns immutable merged source; Python times only include/conflict phase. Warm files, no writes or restart.'},null,2));}finally{await rm(dir,{recursive:true,force:true});}
