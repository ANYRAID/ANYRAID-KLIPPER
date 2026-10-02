import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {AUTOSAVE_HEADER,splitKlipperAutosave,stripAutosaveDuplicates} from '../src/config/klipper-autosave.ts';
const valid='[printer]\nkinematics: cartesian\n'+AUTOSAVE_HEADER+'#*# [bed_mesh default]\n#*# points =\n#*#   .1, .2\n#*# version = 1\n';
const cases=['', '[printer]\n',valid,valid+'edited=true',valid+'\n#*# version = 2',valid+AUTOSAVE_HEADER+'#*# x','text\n#*# stray',AUTOSAVE_HEADER+'#*#bad',AUTOSAVE_HEADER,valid+'#*#\n',valid+'\u0085'];
const plain=Array.from({length:500},(_,i)=>`[bed_mesh p${i}]\npoints =\n  .1, .2\n  .3, .4\nversion = 1`).join('\n');const large='[printer]\n'+AUTOSAVE_HEADER+plain.split('\n').map(l=>'#*# '+l).join('\n');
const py=String.raw`
import sys,json,ast,re,logging,time,types
r=json.load(sys.stdin);tree=ast.parse(open(sys.argv[1]).read());nodes=[n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='ConfigAutoSave' or isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='AUTOSAVE_HEADER' for t in n.targets)];ns=dict(re=re,logging=logging);exec(compile(ast.Module(body=nodes,type_ignores=[]),sys.argv[1],'exec'),ns);a=ns['ConfigAutoSave'].__new__(ns['ConfigAutoSave']);config=types.SimpleNamespace(has_option=lambda section,field:section is not None and section.startswith('bed_mesh ') and field.lower()=='points')
def run(s):
 regular,saved=a._find_autosave_data(s);return [regular,saved,a._strip_duplicates(saved,config)]
results=[run(s) for s in r['cases']];times=[]
for i in range(16):
 start=time.perf_counter()
 for j in range(20):result=run(r['large'])
 times.append((time.perf_counter()-start)*1000)
print(json.dumps(dict(results=results,large=result,times=times[5:],python=sys.version.split()[0])))
`;
const ref=JSON.parse(execFileSync(process.env.PYTHON??'python3',['-c',py,fileURLToPath(new URL('../../klippy/configfile.py',import.meta.url))],{input:JSON.stringify({cases,large}),encoding:'utf8',maxBuffer:8*1024**2}));const run=(s:string)=>{const p=splitKlipperAutosave(s);return [p.regular,p.autosave,stripAutosaveDuplicates(p.autosave,(section,field)=>!!section?.startsWith('bed_mesh ')&&field.toLowerCase()==='points')];};assert.deepEqual(cases.map(run),ref.results);assert.deepEqual(run(large),ref.large);const times:number[]=[];for(let i=0;i<16;i++){const start=performance.now();for(let j=0;j<20;j++)run(large);if(i>=5)times.push(performance.now()-start);}const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};};console.log(JSON.stringify({node:process.version,python:ref.python,cases:cases.length+1,exact:true,bytesPerFile:Buffer.byteLength(large),filesPerBatch:20,nodeTime:stats(times),pythonTime:stats(ref.times),scope:'Original ConfigAutoSave extraction and duplicate suppression, exact text comparison. Warmup 5, measurements 11. Includes text bounds in Node; no disk, includes resolution, parsing or writes.'},null,2));
