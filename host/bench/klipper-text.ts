import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {parseKlipperMainText} from '../src/config/klipper-text.ts';
import {AUTOSAVE_HEADER} from '../src/config/klipper-autosave.ts';
const cases=['[x]\na=1\na:2\n[x]\nb=3','[DEFAULT]\nA=1\n[x]\nB:2','[x]\nv: hello\n  world\n\n  next ; comment\n','[x]\nv: a#b\nw: a;b\ny: a ;b','[x]\na: first\n  [not a section]\nb: second','[DEFAULT]\na=one\n'+AUTOSAVE_HEADER+'#*# [new]\n#*# a=two','[x]\na=one\n'+AUTOSAVE_HEADER+'#*# [x]\n#*# a=two\n#*# b=three','[Mixed Case]\nCamelCase: value'];
const large=Array.from({length:500},(_,i)=>`[bed_mesh p${i}]\npoints:\n  .1, .2\n  .3, .4\nversion: 1`).join('\n')+AUTOSAVE_HEADER+'#*# [extra]\n#*# option: 42';
const py=String.raw`
import sys,ast,json,re,logging,configparser,io,time
r=json.load(sys.stdin);tree=ast.parse(open(sys.argv[1]).read());ns=dict(sys=sys,re=re,logging=logging,configparser=configparser,io=io);names=['ConfigAutoSave','ConfigFileReader'];nodes=[n for n in tree.body if isinstance(n,ast.ClassDef) and n.name in names or isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='AUTOSAVE_HEADER' for t in n.targets)];exec(compile(ast.Module(body=nodes,type_ignores=[]),sys.argv[1],'exec'),ns)
a=ns['ConfigAutoSave'].__new__(ns['ConfigAutoSave']);reader=ns['ConfigFileReader']()
def run(s):
 regular,saved=a._find_autosave_data(s);config=reader.build_fileconfig(regular,'test');saved=a._strip_duplicates(saved,config);reader.append_fileconfig(config,saved,'autosave');return dict(DEFAULT=dict(config.defaults()),**{section:dict(config.items(section)) for section in config.sections()})
results=[run(s) for s in r['cases']];times=[]
for i in range(16):
 start=time.perf_counter()
 for j in range(10):result=run(r['large'])
 times.append((time.perf_counter()-start)*1000)
print(json.dumps(dict(results=results,large=result,times=times[5:],python=sys.version.split()[0])))
`;
const ref=JSON.parse(execFileSync(process.env.PYTHON??'python3',['-c',py,fileURLToPath(new URL('../../klippy/configfile.py',import.meta.url))],{input:JSON.stringify({cases,large}),encoding:'utf8',maxBuffer:8*1024**2}));const run=(s:string)=>JSON.parse(JSON.stringify(parseKlipperMainText(s,'test').original));assert.deepEqual(cases.map(run),ref.results);assert.deepEqual(run(large),ref.large);const times:number[]=[];for(let i=0;i<16;i++){const start=performance.now();for(let j=0;j<10;j++)run(large);if(i>=5)times.push(performance.now()-start);}const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};};console.log(JSON.stringify({node:process.version,python:ref.python,cases:cases.length+1,exact:true,bytes:Buffer.byteLength(large),filesPerBatch:10,nodeTime:stats(times),pythonTime:stats(ref.times),scope:'Original ConfigFileReader parser plus ConfigAutoSave extraction/dedup/append. Includes Node immutable source and JSON-compatible comparison copy. No disk/include expansion/writes.'},null,2));
