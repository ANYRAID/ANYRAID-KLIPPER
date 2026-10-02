import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {runUsbFlashCommand} from '../src/diagnostics/flash-usb-system.ts';
const warmup=5,runs=31,command=[process.execPath,'-e','process.exit(0)'],repository=process.cwd();
function stats(values:number[]){const s=[...values].sort((a,b)=>a-b);return {medianMs:s[Math.floor(s.length/2)],p95Ms:s[Math.ceil(s.length*.95)-1]};}
const samples:number[]=[];
for(let i=0;i<warmup+runs;i++){const at=performance.now();await runUsbFlashCommand(command,repository,new AbortController().signal);if(i>=warmup)samples.push(performance.now()-at);}
const python=JSON.parse(execFileSync(process.env.PYTHON??'/usr/bin/python3',['-c',String.raw`
import json,subprocess,time,sys
r=json.load(sys.stdin);samples=[]
for i in range(r['warmup']+r['runs']):
 at=time.perf_counter();subprocess.run(r['command'],cwd=r['repository'],check=True);elapsed=(time.perf_counter()-at)*1000
 if i>=r['warmup']:samples.append(elapsed)
print(json.dumps(dict(version=sys.version.split()[0],samples=samples)))
`],{input:JSON.stringify({warmup,runs,command,repository}),encoding:'utf8'}));
console.log(JSON.stringify({node:process.version,python:python.version,warmup,runs,scope:'Successful empty Node subprocess startup and close, inherited stdio. Node creates a cancellation process group; Python uses original-style subprocess invocation. No USB, sudo, firmware writes or print-speed measurement.',nodeTiming:stats(samples),pythonTiming:stats(python.samples)},null,2));
