import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {enterUsbBootloader} from '../src/diagnostics/usb-bootloader.ts';
import {ptyPair} from '../test/helpers/pty.ts';
const pair=ptyPair(),warmup=5,runs=31,batch=1000;
function stats(values:number[]){const s=[...values].sort((a,b)=>a-b);return {medianMs:s[Math.floor(s.length/2)],p95Ms:s[Math.ceil(s.length*.95)-1]};}
try{
 const samples:number[]=[],signal=new AbortController().signal;
 for(let i=0;i<warmup+runs;i++){const at=performance.now();for(let j=0;j<batch;j++){let failed=false;try{await enterUsbBootloader(pair.path,signal);}catch(error){assert.match(String(error),/Raise USB bootloader DTR/);failed=true;}assert.ok(failed);}if(i>=warmup)samples.push(performance.now()-at);}
 const python=JSON.parse(execFileSync(process.env.PYTHON??'/usr/bin/python3',['-c',String.raw`
import json,runpy,sys,time
r=runpy.run_path(sys.argv[1]);q=json.load(sys.stdin);samples=[]
for i in range(q['warmup']+q['runs']):
 at=time.perf_counter()
 for j in range(q['batch']):r['enter_bootloader'](q['path'])
 if i>=q['warmup']:samples.append((time.perf_counter()-at)*1000)
print(json.dumps(dict(version=sys.version.split()[0],samples=samples)))
`,fileURLToPath(new URL('../../scripts/flash_usb.py',import.meta.url))],{input:JSON.stringify({warmup,runs,batch,path:pair.path}),encoding:'utf8'}));
 console.log(JSON.stringify({node:process.version,python:python.version,warmup,runs,batch,scope:'Real PTY failure at first DTR ioctl only. Node includes flock and observable rejected Promise/assertion; Python silently swallows the same unsupported ioctl. Does not measure successful physical bootloader entry or printing.',nodeTiming:stats(samples),pythonTiming:stats(python.samples)},null,2));
}finally{await pair.close();}
