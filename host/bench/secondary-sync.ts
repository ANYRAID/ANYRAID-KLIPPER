import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir,cpus} from 'node:os';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {ClockSync} from '../src/timing/clock-sync.ts';
import {SecondarySync} from '../src/timing/secondary-sync.ts';
const samples=Array.from({length:5000},(_,index)=>{const i=index+1,t=i*.9839;return {main:{clock32:Math.trunc(t*(64000000+125))>>>0,sentTime:i%53?10+t-(i%17===0?.02:0):0,receiveTime:10+t+.002+(i%7)*.0001},local:{clock32:Math.trunc(t*(48000000-80))>>>0,sentTime:i%67?10+t:0,receiveTime:10+t+.003+(i%5)*.0001},printTime:t+(i%7)*.2,eventTime:10+t+.005};});
const python=String.raw`
import ast,sys,json,math,logging,time,types
logging.disable(logging.CRITICAL)
source=open(sys.argv[1]).read();RTT_AGE=.000010/3600.;DECAY=1./30.;TRANSMIT_EXTRA=.001
for node in ast.parse(source).body:
 if isinstance(node,ast.ClassDef) and node.name in ['ClockSync','SecondarySync']:exec(ast.get_source_segment(source,node),globals())
samples=json.load(open(sys.argv[2]))
def setup(s,freq):
 s.mcu_freq=freq;s.time_avg=10.;s.clock_est=(10.,0.,freq);s.prediction_variance=(.001*freq)**2;s.serial=types.SimpleNamespace(set_clock_est=lambda *args:None)
def run(capture=False):
 reactor=types.SimpleNamespace(register_timer=lambda f:None);main=ClockSync(reactor);local=SecondarySync(reactor,main);setup(main,64000000.);setup(local,48000000.);local.clock_adj=(0.,48000000.);local.calibrate_clock(0.,10.)
 results=[]
 for i,p in enumerate(samples):
  for s,key in [(main,'main'),(local,'local')]:
   if i<8:s.last_prediction_time=-9999.
   sample=p[key];s._handle_clock({'clock':sample['clock32'],'#sent_time':sample['sentTime'],'#receive_time':sample['receiveTime']})
  offset,freq=local.calibrate_clock(p['printTime'],p['eventTime'])
  if capture:results.append([offset,freq,local.last_sync_time,str(local.print_time_to_clock(p['printTime']+.5))])
 return results
results=run(True)
for _ in range(3):run()
times=[]
for _ in range(11):
 t=time.perf_counter();run();times.append((time.perf_counter()-t)*1000)
print(json.dumps({'results':results,'times':sorted(times)}))
`;
const dir=mkdtempSync(join(tmpdir(),'anyraid-secondary-sync-'));let oracle:{results:[number,number,number,string][];times:number[]};
try{const input=join(dir,'samples.json');writeFileSync(input,JSON.stringify(samples));const p=spawnSync(process.env.PYTHON??'python3',['-c',python,fileURLToPath(new URL('../../klippy/clocksync.py',import.meta.url)),input],{encoding:'utf8',maxBuffer:8*1024*1024,timeout:60000});assert.equal(p.status,0,p.stderr);oracle=JSON.parse(p.stdout);}finally{rmSync(dir,{recursive:true,force:true});}
let maxOffsetError=0,maxClockError=0,maxFrequencyError=0,maxSyncTimeError=0;const sink={calibrateClock(){}};
function run(compare=false){const main=new ClockSync(64000000,0n,10),local=new ClockSync(48000000,0n,10),sync=new SecondarySync(main,local,10);
 samples.forEach((sample,i)=>{main.accept(sample.main,i<8);local.accept(sample.local,i<8);const candidate=sync.propose(sample.printTime,sample.eventTime);sync.apply(candidate,sink,['secondary']);if(compare){const expected=oracle.results[i];maxOffsetError=Math.max(maxOffsetError,Math.abs(candidate.offset-expected[0]));maxClockError=Math.max(maxClockError,Math.abs(Number(sync.printTimeToClock(sample.printTime+.5)-BigInt(expected[3]))));maxFrequencyError=Math.max(maxFrequencyError,Math.abs(candidate.frequency-expected[1]));maxSyncTimeError=Math.max(maxSyncTimeError,Math.abs(candidate.syncTime-expected[2]));}});
}
run(true);assert.equal(maxOffsetError,0);assert(maxClockError===0,`Clock error ${maxClockError}`);assert(maxFrequencyError===0,`Frequency error ${maxFrequencyError}`);assert(maxSyncTimeError===0,`Horizon error ${maxSyncTimeError}`);
for(let i=0;i<3;i++)run();const times=[];for(let i=0;i<11;i++){const t=performance.now();run();times.push(performance.now()-t);}times.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,samples:samples.length,maxOffsetError,maxClockError,maxFrequencyError,maxSyncTimeError,nodeMedianMs:times[5],nodeP95Ms:times[10],pythonMedianMs:oracle.times[5],pythonP95Ms:oracle.times[10],speedup:oracle.times[5]/times[5]},null,2));
