import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export function firmwareIdentityReference(image:Uint8Array,runs=1):{identity:{mcu?:string;version?:string}|null;samples:number[];python:string}{return JSON.parse(execFileSync(process.env.PYTHON??'/usr/bin/python3',['-c',String.raw`
import runpy,sys,json,tempfile,pathlib,contextlib,io,time
r=runpy.run_path(sys.argv[1]);q=json.load(sys.stdin);samples=[]
with tempfile.TemporaryDirectory() as directory:
 p=pathlib.Path(directory)/'klipper.bin';p.write_bytes(bytes.fromhex(q['image']))
 with contextlib.redirect_stdout(io.StringIO()):
  for i in range(q['runs']):
   at=time.perf_counter();f=r['CanFlasher'](None,p);samples.append((time.perf_counter()-at)*1000)
 d=f.klipper_dict
 result=None if d is None else dict(mcu=d.get('config',{}).get('MCU'),version=d.get('version'))
print(json.dumps(dict(identity=result,samples=samples,python=sys.version.split()[0])))
`,fileURLToPath(new URL('../../lib/katapult/flashtool.py',import.meta.url))],{input:JSON.stringify({image:Buffer.from(image).toString('hex'),runs}),encoding:'utf8',timeout:30000,maxBuffer:4*1024**2}));}
