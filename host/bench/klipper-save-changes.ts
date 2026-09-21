import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {KlipperSaveChanges} from '../src/config/klipper-save-changes.ts';
type Op=['set',string,string,string]|['remove',string];
const initial={x:{value:'old'},X:{value:'distinct'}};
const ops:Op[]=[['set','x','Value','new'],['set','x','value','new'],['remove','x'],['remove','x'],['remove','unknown'],['set','x','points','\n1,2\n3,4'],['set','__proto__','constructor','safe'],['remove','X'],['set','X','VALUE','again']];
const large=Object.fromEntries(Array.from({length:200},(_,i)=>[`bed_mesh p${i}`,{version:'1',points:'\n.1,.2\n.3,.4',min_x:'0',max_x:'200'}]));
const py=String.raw`
import sys,ast,json,re,logging,configparser,time,copy
r=json.load(sys.stdin);tree=ast.parse(open(sys.argv[1]).read());ns=dict(re=re,logging=logging);exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='ConfigAutoSave'],type_ignores=[]),sys.argv[1],'exec'),ns)
def create(values):
 a=ns['ConfigAutoSave'].__new__(ns['ConfigAutoSave']);a.fileconfig=configparser.RawConfigParser();a.fileconfig.read_dict(values);a.status_save_pending={};a.save_config_pending=False;return a
a=create(r['initial']);results=[]
for op in r['ops']:
 if op[0]=='set':a.set(*op[1:])
 else:a.remove_section(op[1])
 results.append(dict(status=copy.deepcopy(a.get_status(0)),values={s:dict(a.fileconfig.items(s)) for s in a.fileconfig.sections()}))
a=create(r['large']);times=[]
for i in range(16):
 start=time.perf_counter()
 for j in range(20):a.set('bed_mesh p0','version','1')
 times.append((time.perf_counter()-start)*1000)
print(json.dumps(dict(results=results,times=times[5:],python=sys.version.split()[0])))
`;
const ref=JSON.parse(execFileSync(process.env.PYTHON??'python3',['-c',py,fileURLToPath(new URL('../../klippy/configfile.py',import.meta.url))],{input:JSON.stringify({initial,ops,large}),encoding:'utf8'}));
const s=new KlipperSaveChanges(initial),results=[];
for(const op of ops){if(op[0]==='set')s.set(op[1],op[2],op[3]);else s.removeSection(op[1]);results.push({status:s.status,values:s.capture().values});}
assert.deepEqual(JSON.parse(JSON.stringify(results)),ref.results);
const b=new KlipperSaveChanges(large),times:number[]=[];
for(let i=0;i<16;i++){const start=performance.now();for(let j=0;j<20;j++)b.set('bed_mesh p0','version','1');if(i>=5)times.push(performance.now()-start);}
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};};
console.log(JSON.stringify({node:process.version,python:ref.python,operations:ops.length,exact:true,profiles:200,setsPerBatch:20,nodeTime:stats(times),pythonTime:stats(ref.times),scope:'Actual ConfigAutoSave set/remove/status; string values. Node additionally validates complete save serialization on each update. Configuration-time only; no disk writes, restart, or motion-loop benchmark.'},null,2));
