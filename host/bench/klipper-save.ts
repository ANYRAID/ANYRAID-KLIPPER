import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {buildKlipperSave,type SavedConfiguration} from '../src/config/klipper-save.ts';
import {AUTOSAVE_HEADER} from '../src/config/klipper-autosave.ts';
const cases:{current:string;saved:SavedConfiguration}[]=[{current:'[x]\na: old\nb: keep\n',saved:{x:{a:'new'}}},{current:'[x]\npoints:\n  1,2\n  3,4\n',saved:{x:{points:'\n5,6\n7,8'}}},{current:'[x]\na: 1\n'+AUTOSAVE_HEADER+'#*# [old]\n#*# a: 1\n',saved:{x:{a:'2'},y:{empty:''}}},{current:'[x]\na: 1\n',saved:{DEFAULT:{v:'default'},x:{a:'2'},y:{v:'other'}}},{current:'[x]\na: 1\n',saved:{}}];
const saved:SavedConfiguration=Object.fromEntries(Array.from({length:200},(_,i)=>[`bed_mesh p${i}`,{version:'1',points:'\n.1,.2\n.3,.4',min_x:'0',max_x:'200'}]));const large={current:'[printer]\nkinematics: cartesian\n',saved};
const py=String.raw`
import sys,ast,json,re,logging,configparser,io,time
r=json.load(sys.stdin);tree=ast.parse(open(sys.argv[1]).read());ns=dict(sys=sys,re=re,logging=logging,configparser=configparser,io=io);nodes=[n for n in tree.body if isinstance(n,ast.ClassDef) and n.name in ['ConfigAutoSave','ConfigFileReader'] or isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='AUTOSAVE_HEADER' for t in n.targets)];exec(compile(ast.Module(body=nodes,type_ignores=[]),sys.argv[1],'exec'),ns);a=ns['ConfigAutoSave'].__new__(ns['ConfigAutoSave']);reader=ns['ConfigFileReader']()
def run(c):
 config=reader._create_fileconfig()
 for name,values in c['saved'].items():
  if name!='DEFAULT':config.add_section(name)
  for key,value in values.items():config.set(name,key,value)
 if not config.sections():return None
 body=reader.build_config_string(config);lines=[('#*# '+line).strip() for line in body.split('\n')];lines.insert(0,'\n'+ns['AUTOSAVE_HEADER'].rstrip());lines.append('');regular,_=a._find_autosave_data(c['current']);regular=a._strip_duplicates(regular,config);return regular.rstrip()+'\n'.join(lines)
results=[run(c) for c in r['cases']];result=run(r['large']);times=[]
for i in range(16):
 start=time.perf_counter()
 for j in range(10):run(r['large'])
 times.append((time.perf_counter()-start)*1000)
print(json.dumps(dict(results=results,large=result,times=times[5:],python=sys.version.split()[0])))
`;
const ref=JSON.parse(execFileSync(process.env.PYTHON??'python3',['-c',py,fileURLToPath(new URL('../../klippy/configfile.py',import.meta.url))],{input:JSON.stringify({cases,large}),encoding:'utf8',maxBuffer:8*1024**2}));assert.deepEqual(cases.map(c=>buildKlipperSave(c.current,c.saved)?.text??null),ref.results);const output=buildKlipperSave(large.current,large.saved)!;assert.equal(output.text,ref.large);const times:number[]=[];for(let i=0;i<16;i++){const start=performance.now();for(let j=0;j<10;j++)buildKlipperSave(large.current,large.saved);if(i>=5)times.push(performance.now()-start);}const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};};console.log(JSON.stringify({node:process.version,python:ref.python,cases:cases.length+1,exact:true,profiles:200,bytes:Buffer.byteLength(output.text),candidatesPerBatch:10,nodeTime:stats(times),pythonTime:stats(ref.times),scope:'Original ConfigFileReader serialization and autosave extraction/dedup; prefix assembly from SAVE_CONFIG. Node includes extra reparse/round-trip checks. No include conflict resolution, disk replacement or restart.'},null,2));
