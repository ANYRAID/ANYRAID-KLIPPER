import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {Htu21dSensor,htuCrc,decodeHtu21d} from '../src/thermal/htu21d.ts';
const source=fileURLToPath(new URL('../../klippy/extras/htu21d.py',import.meta.url));
const python=`import importlib.util,types,sys,time,json,logging
logging.disable(logging.CRITICAL)
pkg=types.ModuleType('htu_reference');pkg.bus=types.ModuleType('htu_reference.bus');sys.modules['htu_reference']=pkg
spec=importlib.util.spec_from_file_location('htu_reference.htu',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
c=module.HTU21D.__new__(module.HTU21D)
frames=[]
for i in range(4096):
 t=(i*7919%65536)&65532;h=((i*104729%65536)&65532)|2
 frames.append([bytes([t>>8,t&255,c._chekCRC8(t)]),bytes([h>>8,h&255,c._chekCRC8(h)])])
class Bus:
 def i2c_write(self,data): self.which=0 if data[0]==243 else 1
 def i2c_read(self,data,n): return {'response':frames[self.index][self.which]}
 def get_mcu(self): return types.SimpleNamespace(estimated_print_time=lambda t:0)
c.i2c=Bus();c.reactor=types.SimpleNamespace(monotonic=lambda:0,pause=lambda t:None);c.report_time=30;c.min_temp=-100;c.max_temp=200;c._callback=lambda t,v:None;c.deviceId='HTU21D';c.resolution='TEMP12_HUM08';c.hold_master_mode=False
values=[]
for i in range(4096):
 c.i2c.index=i;assert c._sample_htu21d(0)==30;values.append([c.temp,c.humidity])
c.i2c.index=123
start=time.perf_counter()
for i in range(100000): assert c._sample_htu21d(0)==30
print(json.dumps({'ms':(time.perf_counter()-start)*1000,'values':values,'crc':bytes(c._chekCRC8(i) for i in range(65536)).hex()}))`;
const frame=(n:number)=>Uint8Array.of(n>>>8,n&255,htuCrc(n));
const frames=Array.from({length:4096},(_,i)=>[frame(i*7919%65536&65532),frame((i*104729%65536&65532)|2)]);
const baseline:number[]=[],current:number[]=[],signal=new AbortController().signal;let maximumTemperatureCorrection=0,maximumHumidityCorrection=0;
for(let round=0;round<8;round++)for(const which of round%2?['ts','python']:['python','ts']){
 let ms:number;
 if(which==='python'){
  const result=JSON.parse(execFileSync('python3',['-c',python,source],{encoding:'utf8',maxBuffer:2**20}));ms=result.ms;
  assert.equal(Buffer.from(Array.from({length:65536},(_,i)=>htuCrc(i))).toString('hex'),result.crc);
  for(let i=0;i<frames.length;i++){const [t,h]=frames[i],rawT=t[0]*256+t[1],rawH=(h[0]*256+h[1])&65532,legacy=result.values[i];assert.equal(legacy[0],.002681*rawT-46.85);assert.equal(legacy[1],Math.max(0,Math.min(100,.001907*rawH-6)));const actual=decodeHtu21d(t,h,'HTU21D');maximumTemperatureCorrection=Math.max(maximumTemperatureCorrection,Math.abs(actual.temperature-legacy[0]));maximumHumidityCorrection=Math.max(maximumHumidityCorrection,Math.abs(actual.humidity-legacy[1]));}
 }else{
  let reg=2,humidity=false;const sensor=new Htu21dSensor({async transfer(b,n){if(b[0]===252)return frame(0x3200);if(b[0]===231)return Uint8Array.of(reg);if(b[0]===230)reg=b[1];if(b[0]===243||b[0]===245)humidity=b[0]===245;return n===3?frames[123][humidity?1:0]:Buffer.alloc(0);}},'HTU21D',{resolution:'TEMP12_HUM08',hold:false},async()=>{});await sensor.initialize(signal);
  const start=performance.now();for(let i=0;i<100000;i++)await sensor.sample(signal);ms=performance.now()-start;
 }
 if(round>=3)(which==='python'?baseline:current).push(ms);
}
const stats=(samplesMs:number[])=>({samplesMs,medianMs:[...samplesMs].sort((a,b)=>a-b)[2]});const result={runtime:process.version,scope:'100000 original Python sample callbacks vs TS async driver; fake I2C and waits; Python includes range/callback/report handling, TS excludes periodic owner; 3 warmups and 5 alternating retained rounds',crcWordsExactlyMatched:65536,numericSamplesCompared:4096,maximumTemperatureCorrection,maximumHumidityCorrection,corrections:'Full manufacturer scaling, both status bits masked, actual HTU21D-only temperature compensation and final humidity clamp. Legacy compensation expression had no effect.',baseline:stats(baseline),current:stats(current)};console.log(JSON.stringify(result,null,2));assert(result.current.medianMs<=result.baseline.medianMs*1.1,'HTU driver regression');
