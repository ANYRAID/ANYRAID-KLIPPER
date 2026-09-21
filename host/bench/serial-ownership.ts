import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {assertSerialAvailable} from '../src/diagnostics/serial-ownership.ts';
import {ptyPair} from '../test/helpers/pty.ts';
const pair=ptyPair(),warmup=5,runs=11,samples:number[]=[];
function stats(values:number[]){const s=[...values].sort((a,b)=>a-b);return {medianMs:s[Math.floor(s.length/2)],p95Ms:s[Math.ceil(s.length*.95)-1]};}
try{
 let report;for(let i=0;i<warmup+runs;i++){const at=performance.now();report=await assertSerialAvailable(pair.path,new AbortController().signal);if(i>=warmup)samples.push(performance.now()-at);}
 const python=spawn(process.env.PYTHON??'/usr/bin/python3',['-c',String.raw`
import runpy,sys,json,asyncio,time
r=runpy.run_path(sys.argv[1]);q=json.loads(sys.argv[2]);samples=[]
async def main():
 s=object.__new__(r['SerialSocket'])
 for i in range(q['warmup']+q['runs']):
  at=time.perf_counter();await s.validate_device(q['device'])
  if i>=q['warmup']:samples.append((time.perf_counter()-at)*1000)
asyncio.run(main());print(json.dumps(dict(version=sys.version.split()[0],samples=samples)))
`,fileURLToPath(new URL('../../lib/katapult/flashtool.py',import.meta.url)),JSON.stringify({device:pair.path,warmup,runs})],{stdio:['ignore','pipe','pipe']});let output='',error='';python.stdout.on('data',b=>output+=b);python.stderr.on('data',b=>error+=b);const timer=setTimeout(()=>python.kill('SIGKILL'),30000);let reference;try{const code=await new Promise((resolve,reject)=>{python.once('error',reject);python.once('close',resolve);});if(code!==0)throw new Error(error||String(code));reference=JSON.parse(output);}finally{clearTimeout(timer);}
 console.log(JSON.stringify({node:process.version,python:reference.version,warmup,runs,report,nodeTiming:stats(samples),pythonTiming:stats(reference.samples),scope:'Same live host /proc, idle real PTY slave, sequential scans. Process/fd population can change; Python validates inode pairs, Node additionally compares character device rdev and uses bounded asynchronous batches. No physical device or printing.'},null,2));
}finally{await pair.close();}
