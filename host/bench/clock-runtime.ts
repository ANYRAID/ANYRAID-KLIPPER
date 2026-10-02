import {performance} from 'node:perf_hooks';
import {cpus,tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {ClockRuntime} from '../src/timing/clock-runtime.ts';
import type {ClockSample,ReleaseEstimate} from '../src/timing/clock-sync.ts';
import {FakeClock} from '../test/helpers/clock-scheduler.ts';
const count=5000;
async function run(capture=false){const clock=new FakeClock(),samples:ClockSample[]=[],estimates:ReleaseEstimate[]=[];let replies=0;
 const runtime=new ClockRuntime(1e6,{async uptime(){return {high:0,clock32:1000000,sentTime:clock.time,receiveTime:clock.time};},async queryClock(){replies++;const sample={clock32:Math.round(1000000+(clock.time-10)*1e6)>>>0,sentTime:replies===8?0:clock.time,receiveTime:clock.time};if(capture)samples.push(sample);return sample;},setClockEstimate(e){if(capture)estimates.push(e);},async stop(){}},clock);
 const start=runtime.start();await clock.advance(.41);await start;const times=[];
 for(let i=0;i<count;i++){const before=performance.now();await clock.advance(.9839);runtime.assertActive();times.push(performance.now()-before);}
 assert.equal(replies,count+9);await runtime.stop();assert.equal(clock.pending,0);times.sort((a,b)=>a-b);return {samples,estimates,median:times[Math.floor(count*.5)],p95:times[Math.floor(count*.95)],max:times[count-1]};
}
const actual=await run(true),dir=mkdtempSync(join(tmpdir(),'anyraid-clock-runtime-'));let maxClockError=0,maxFrequencyError=0;
try{const input=join(dir,'samples.json');writeFileSync(input,JSON.stringify(actual.samples));
 const python=String.raw`
import ast,sys,json,math,logging,types
logging.disable(logging.CRITICAL)
source=open(sys.argv[1]).read();RTT_AGE=.000010/3600.;DECAY=1./30.;TRANSMIT_EXTRA=.001
node=next(n for n in ast.parse(source).body if isinstance(n,ast.ClassDef) and n.name=='ClockSync');exec(ast.get_source_segment(source,node),globals())
s=ClockSync(types.SimpleNamespace(register_timer=lambda f:None));s.mcu_freq=1e6;s.time_avg=10.;s.clock_avg=1e6;s.clock_est=(10.,1e6,1e6);s.last_clock=1000000;s.prediction_variance=(.001*1e6)**2
results=[];s.serial=types.SimpleNamespace(set_clock_est=lambda *args:results.append(args))
for i,p in enumerate(json.load(open(sys.argv[2]))):
 if i<8:s.last_prediction_time=-9999.
 s._handle_clock({'clock':p['clock32'],'#sent_time':p['sentTime'],'#receive_time':p['receiveTime']})
print(json.dumps(results))
`;
 const p=spawnSync(process.env.PYTHON??'python3',['-c',python,fileURLToPath(new URL('../../klippy/clocksync.py',import.meta.url)),input],{encoding:'utf8',maxBuffer:8*1024*1024,timeout:60000});assert.equal(p.status,0,p.stderr);const expected=JSON.parse(p.stdout) as [number,number,number][];assert.equal(actual.estimates.length,expected.length);
 actual.estimates.forEach((e,i)=>{maxClockError=Math.max(maxClockError,Math.abs(Number(e.clock-BigInt(expected[i][2]))));maxFrequencyError=Math.max(maxFrequencyError,Math.abs(e.frequency-expected[i][0]));assert.equal(e.sampleTime,expected[i][1]);});assert(maxClockError<=1);assert(maxFrequencyError<1e-5);
}finally{rmSync(dir,{recursive:true,force:true});}
const warm=await run();
console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,steadyQueries:count,estimatesCompared:actual.estimates.length,maxClockError,maxFrequencyError,callbackMedianMs:warm.median,callbackP95Ms:warm.p95,callbackMaxMs:warm.max,periodMs:983.9,scope:'Includes fake scheduler and promise draining; no wire latency or hardware acceptance'},null,2));
