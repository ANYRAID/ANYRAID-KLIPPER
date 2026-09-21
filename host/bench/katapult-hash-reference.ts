import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export function katapultHashReference(cases:{hex:string;seed:string}[],runs=1):{hashes:string[];uuids:string[];samples:number[];python:string}{return JSON.parse(execFileSync(process.env.PYTHON??'/usr/bin/python3',['-c',String.raw`
import sys,runpy,json,io,contextlib,time
r=runpy.run_path(sys.argv[1]);q=json.load(sys.stdin);samples=[]
with contextlib.redirect_stdout(io.StringIO()):
 for i in range(q['runs']):
  at=time.perf_counter();hashes=[format(r['fasthash64'](bytes.fromhex(c['hex']),int(c['seed'])),'016x') for c in q['cases']];uuids=[format(r['convert_usbsn_to_uuid'](c['hex']),'012x') for c in q['cases']];samples.append((time.perf_counter()-at)*1000)
print(json.dumps(dict(hashes=hashes,uuids=uuids,samples=samples,python=sys.version.split()[0])))
`,fileURLToPath(new URL('../../lib/katapult/flashtool.py',import.meta.url))],{input:JSON.stringify({cases,runs}),encoding:'utf8',timeout:30000,maxBuffer:8*1024**2}));}
