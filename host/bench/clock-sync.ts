import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir,cpus} from 'node:os';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {ClockSync} from '../src/timing/clock-sync.ts';
const frequency=64000000;
const samples=Array.from({length:5000},(_,index)=>{
  const i=index+1,time=i*.9839;
  return {clock32:Math.trunc(time*(frequency+125))>>>0,sentTime:i%53===0?0:10+time-(i%17===0?.02:0),receiveTime:10+time+.002+(i%7)*.0001};
});
const python=String.raw`
import ast,sys,json,math,logging,time,types
logging.disable(logging.CRITICAL)
text=open(sys.argv[1]).read();node=next(n for n in ast.parse(text).body if isinstance(n,ast.ClassDef) and n.name=='ClockSync')
RTT_AGE=.000010/3600.;DECAY=1./30.;TRANSMIT_EXTRA=.001
exec(ast.get_source_segment(text,node),globals())
samples=json.load(open(sys.argv[2]))
def run(capture=False):
 s=ClockSync(types.SimpleNamespace(register_timer=lambda f:None));s.mcu_freq=64000000.;s.time_avg=10.;s.clock_est=(10.,0.,s.mcu_freq);s.prediction_variance=(.001*s.mcu_freq)**2
 calls=[];s.serial=types.SimpleNamespace(set_clock_est=lambda *args:calls.append(args))
 result=[]
 for i,p in enumerate(samples):
  calls.clear()
  if i<8:s.last_prediction_time=-9999.
  s._handle_clock({'clock':p['clock32'],'#sent_time':p['sentTime'],'#receive_time':p['receiveTime']})
  if capture:result.append({'release':calls[0] if calls else None,'clock':s.get_clock(p['receiveTime']+.25),'last':s.last_clock,'estimate':s.clock_est})
 return result
results=run(True)
for _ in range(3):run()
times=[]
for _ in range(11):
 start=time.perf_counter();run();times.append((time.perf_counter()-start)*1000)
print(json.dumps({'results':results,'times':sorted(times)}))
`;
const directory=mkdtempSync(join(tmpdir(),'anyraid-clock-'));
let oracle:{results:{release:[number,number,number]|null;clock:number;last:number;estimate:number[]}[];times:number[]};
try {
  const path=join(directory,'samples.json');writeFileSync(path,JSON.stringify(samples));
  const result=spawnSync(process.env.PYTHON??'python3',['-c',python,fileURLToPath(new URL('../../klippy/clocksync.py',import.meta.url)),path],{encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});
  if(result.status!==0) throw new Error(result.stderr||String(result.error));oracle=JSON.parse(result.stdout);
} finally {rmSync(directory,{recursive:true,force:true});}
let maxFrequencyError=0,maxClockError=0,accepted=0;
function run(compare=false):void {
  const sync=new ClockSync(frequency,0n,10);
  samples.forEach((sample,i)=>{
    const release=sync.accept(sample,i<8);
    if(!compare) return;
    const expected=oracle.results[i];
    assert.equal(release===null,expected.release===null);
    assert.equal(sync.lastClock,BigInt(expected.last));
    const clockError=Math.abs(Number(sync.getClock(sample.receiveTime+.25))-expected.clock);
    maxClockError=Math.max(maxClockError,clockError);assert.ok(clockError<=1);
    if(release) {
      assert.ok(expected.release);
      accepted++;
      maxFrequencyError=Math.max(maxFrequencyError,Math.abs(release.frequency-expected.release[0]));
      assert.ok(Math.abs(release.frequency-expected.release[0])<1e-6);
      assert.equal(release.clock,BigInt(expected.release[2]));
      assert.equal(release.sampleTime,expected.release[1]);
    }
  });
}
run(true);for(let i=0;i<3;i++) run();
const times=[];
for(let i=0;i<11;i++) {const start=performance.now();run();times.push(performance.now()-start);}
times.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,samples:samples.length,accepted,maxFrequencyError,maxClockError,nodeMedianMs:times[5],pythonMedianMs:oracle.times[5],nodeP95Ms:times[10],pythonP95Ms:oracle.times[10],speedup:oracle.times[5]/times[5]},null,2));
assert.ok(times[5]<=oracle.times[5],'Clock estimation regressed against Python');
