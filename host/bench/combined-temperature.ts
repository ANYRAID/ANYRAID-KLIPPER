import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {CombinedTemperature} from '../src/thermal/combined-temperature.ts';
const source=fileURLToPath(new URL('../../klippy/extras/temperature_combined.py',import.meta.url));
const python=`import runpy,time,json,sys
module=runpy.run_path(sys.argv[1])
class Sensor:
 def __init__(self,t): self.t=t
 def get_status(self,t): return {'temperature':self.t}
class Printer:
 def invoke_shutdown(self,reason): raise Exception(reason)
c=module['PrinterSensorCombined'].__new__(module['PrinterSensorCombined'])
c.sensors=[Sensor(200+i) for i in range(8)]
c.max_deviation=10;c.apply_mode=module['mean'];c.last_temp=0;c.printer=Printer()
t=time.perf_counter()
for i in range(100000): c.update_temp(i)
elapsed=(time.perf_counter()-t)*1000
assert c.last_temp==203.5
print(json.dumps({'ms':elapsed,'temperature':c.last_temp}))`;
const baseline:number[]=[],current:number[]=[];
for(let round=0;round<8;round++)for(const which of round%2?['current','python']:['python','current']){
 let ms:number;
 if(which==='python')ms=JSON.parse(execFileSync('python3',['-c',python,source],{encoding:'utf8'})).ms;
 else{const c=new CombinedTemperature({method:'mean',maximumDeviation:10,minimum:0,maximum:300},Array.from({length:8},(_,i)=>()=>({temperature:200+i,stale:false})));const start=performance.now();for(let i=0;i<100000;i++)c.sample();ms=performance.now()-start;if(c.getTemperature().temperature!==203.5)throw Error('Temperature mismatch');}
 if(round>=3)(which==='python'?baseline:current).push(ms);
}
const stats=(v:number[])=>({samplesMs:v,medianMs:[...v].sort((a,b)=>a-b)[2]});
console.log(JSON.stringify({runtime:process.version,scope:'100000 updates with 8 sources: original Python update_temp vs TypeScript validation and compensated mean; 3 warmups and 5 alternating retained runs; excludes scheduling and device IO',baseline:stats(baseline),current:stats(current)},null,2));
if(stats(current).medianMs>stats(baseline).medianMs*1.1)throw Error('Combined temperature performance regression');
