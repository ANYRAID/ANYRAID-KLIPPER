import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {AhtSensor,decodeAht} from '../src/thermal/aht.ts';
const source=fileURLToPath(new URL('../../klippy/extras/aht10.py',import.meta.url));
const python=`import importlib.util,types,sys,time,json
pkg=types.ModuleType('aht_reference');pkg.bus=types.ModuleType('aht_reference.bus');sys.modules['aht_reference']=pkg
spec=importlib.util.spec_from_file_location('aht_reference.aht10',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
frames=[]
for i in range(4096):
 t=(i*7919)%1048576;h=(i*104729)%1048576
 frames.append(bytes([8,h>>12,(h>>4)&255,((h&15)<<4)|(t>>16),(t>>8)&255,t&255]))
class Bus:
 def i2c_write(self,data): pass
 def i2c_read(self,data,n): return {'response':frames[self.index]}
class Reactor:
 def monotonic(self): return 0
 def pause(self,t): pass
c=module.AHTBase.__new__(module.AHTBase);c.init_sent=True;c.i2c=Bus();c.reactor=Reactor()
values=[]
for i in range(4096):
 c.i2c.index=i;assert c._make_measurement();values.append([c.temp,c.humidity])
c.i2c.index=123
start=time.perf_counter()
for i in range(100000): assert c._make_measurement()
print(json.dumps({'ms':(time.perf_counter()-start)*1000,'values':values}))`;
const frames=Array.from({length:4096},(_,i)=>{const t=i*7919%1048576,h=i*104729%1048576;return Uint8Array.of(8,h>>>12,h>>>4&255,((h&15)<<4)|(t>>>16),t>>>8&255,t&255);});
const baseline:number[]=[],current:number[]=[],signal=new AbortController().signal;
for(let round=0;round<8;round++)for(const which of round%2?['current','python']:['python','current']){
 let ms:number;
 if(which==='python'){
  const result=JSON.parse(execFileSync('python3',['-c',python,source],{encoding:'utf8',maxBuffer:2**20}));ms=result.ms;
  assert.deepEqual(frames.map(f=>{const r=decodeAht(f);return [r.temperature,r.humidity];}),result.values);
 }else{
  const sensor=new AhtSensor({async transfer(_bytes,n){return n?frames[123]:new Uint8Array(0);}},'AHT2X',async()=>{});await sensor.initialize(signal);
  const start=performance.now();for(let i=0;i<100000;i++)await sensor.sample(signal);ms=performance.now()-start;
 }
 if(round>=3)(which==='python'?baseline:current).push(ms);
}
const stats=(samplesMs:number[])=>({samplesMs,medianMs:[...samplesMs].sort((a,b)=>a-b)[2]});
const result={runtime:process.version,scope:'100000 AHT measurements; original Python method vs async TS driver; fake I2C and no-op conversion waits; 4096 frames compared exactly; 3 warmup rounds and 5 alternating retained rounds; excludes serial/electrical IO and 110ms conversion',baseline:stats(baseline),current:stats(current)};
console.log(JSON.stringify(result,null,2));
if(result.current.medianMs>result.baseline.medianMs*1.1)throw new Error('AHT driver performance regression');
