import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {spectrogramCsv} from '../src/calibration/spectrogram-csv.ts';
const frames=255,frequencies=Float64Array.from({length:257},(_,i)=>i*1000.123/512),times=Float64Array.from({length:frames},(_,i)=>(256+i*256)/1000.123),power=Float64Array.from({length:257*frames},(_,i)=>1e-7+(Math.sin(i*.01)+1)*127.123456789),data={frequencies,times,power,frames,fftSize:512,sampleRate:1000.123};
const source=String.raw`
import sys,json,time,io,runpy,numpy as np
fn=runpy.run_path(sys.argv[1])['write_specgram'];d=json.load(sys.stdin)
f=np.array(d['frequencies']);t=np.array(d['times']);p=np.array(d['power']).reshape(len(f),len(t));latest=[]
class Output(io.StringIO):
 def close(self):pass
def opened(*a,**kw):
 latest[:]=[Output()];return latest[0]
fn.__globals__['open']=opened;samples=[]
for i in range(16):
 start=time.perf_counter();fn(p,f,t,'unused');samples.append((time.perf_counter()-start)*1000)
print(json.dumps(dict(samples=samples[5:],csv=latest[0].getvalue(),python=sys.version.split()[0],numpy=np.__version__)))
`;
const ref=JSON.parse(execFileSync(process.env.PYTHON??'python3',['-c',source,fileURLToPath(new URL('../../scripts/graph_accelerometer.py',import.meta.url))],{input:JSON.stringify({frequencies:Array.from(frequencies),times:Array.from(times),power:Array.from(power)}),encoding:'utf8',maxBuffer:16*1024**2}));
const samples:number[]=[];let csv='';for(let i=0;i<16;i++){const at=performance.now();csv=spectrogramCsv(data);if(i>=5)samples.push(performance.now()-at);}
const own=csv.trimEnd().split('\n'),original=ref.csv.trimEnd().split('\n') as string[];assert.equal(own.length,original.length);assert.equal(original[0].split(',')[0],'freq\\t');let maxRoundTripError=0,maxOriginalRounding=0;
for(let row=0;row<own.length;row++){const a=own[row].split(','),b=original[row].split(',');assert.equal(a.length,b.length);for(let col=row===0?1:0;col<a.length;col++){const expected=row===0?times[col-1]:col===0?frequencies[row-1]:power[(row-1)*frames+col-1];maxRoundTripError=Math.max(maxRoundTripError,Math.abs(Number(a[col])-expected));maxOriginalRounding=Math.max(maxOriginalRounding,Math.abs(Number(b[col])-expected));const limit=row===0?5.1e-7:col===0?.051:Math.abs(expected)*5.1e-7+1e-15;assert.ok(Math.abs(Number(b[col])-expected)<=limit);}}
assert.equal(maxRoundTripError,0);const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[Math.floor(a.length/2)],p95Ms:a[Math.ceil(a.length*.95)-1]};};console.log(JSON.stringify({node:process.version,python:ref.python,numpy:ref.numpy,frames,bins:257,warmups:5,runs:11,nodeSerialize:stats(samples),pythonSerialize:stats(ref.samples),nodeBytes:Buffer.byteLength(csv),pythonBytes:Buffer.byteLength(ref.csv),maxRoundTripError,maxOriginalRounding,scope:'Validate and serialize existing matrix. Python original write_specgram uses StringIO and rounded text; Node preserves doubles. FFT, disk, startup and IPC excluded.'},null,2));
