import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {CombinedTemperature} from '../src/thermal/combined-temperature.ts';
const source=fileURLToPath(new URL('../../klippy/extras/temperature_combined.py',import.meta.url));
const additional=process.argv.includes('--additional');
const python=`import runpy,time,json,sys
module=runpy.run_path(sys.argv[1]);extra=sys.argv[2]=='extra'
class Sensor:
 def __init__(self,t): self.t=t
 def get_status(self,t): return {'temperature':self.t}
class Printer:
 def invoke_shutdown(self,reason): raise Exception(reason)
if extra:
 def extra_status(self,t): return {'temperature':self.t,'humidity':50,'pressure':1000,'gas':2}
 Sensor.get_status=extra_status
c=module['PrinterSensorCombined'].__new__(module['PrinterSensorCombined'])
c.sensors=[Sensor(200+i) for i in range(8)]
c.max_deviation=10;c.apply_mode=module['mean'];c.last_temp=0;c.printer=Printer();c.humidity=c.pressure=c.gas=None
t=time.perf_counter()
for i in range(100000):
 c.update_temp(i)
 if extra: c.update_additional(i)
elapsed=(time.perf_counter()-t)*1000
assert c.last_temp==203.5
if extra: assert (c.humidity,c.pressure,c.gas)==(50,1000,2)
print(json.dumps({'ms':elapsed,'temperature':c.last_temp}))`;
const baseline:number[]=[],current:number[]=[];
for(let round=0;round<8;round++)for(const which of round%2?['current','python']:['python','current']){
 let ms:number;
 if(which==='python')ms=JSON.parse(execFileSync('python3',['-c',python,source,additional?'extra':'temperature'],{encoding:'utf8'})).ms;
 else{const c=new CombinedTemperature({method:'mean',maximumDeviation:10,minimum:0,maximum:300},Array.from({length:8},(_,i)=>additional?()=>({temperature:200+i,stale:false,humidity:50,pressure:1000,gas:2}):()=>({temperature:200+i,stale:false})));const start=performance.now();for(let i=0;i<100000;i++)c.sample();ms=performance.now()-start;if(c.getTemperature().temperature!==203.5||additional&&JSON.stringify(c.additional)!==JSON.stringify({humidity:50,pressure:1000,gas:2}))throw Error('Temperature mismatch');}
 if(round>=3)(which==='python'?baseline:current).push(ms);
}
const stats=(v:number[])=>({samplesMs:v,medianMs:[...v].sort((a,b)=>a-b)[2]});
console.log(JSON.stringify({runtime:process.version,additionalFields:additional,scope:'100000 updates with 8 sources: original Python update_temp and optional update_additional vs TypeScript validation and compensated mean; 3 warmups and 5 alternating retained runs; excludes scheduling and device IO',baseline:stats(baseline),current:stats(current)},null,2));
if(stats(current).medianMs>stats(baseline).medianMs*1.1)throw Error('Combined temperature performance regression');
