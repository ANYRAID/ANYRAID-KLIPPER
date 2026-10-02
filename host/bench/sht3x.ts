import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {Sht3xSensor,sht3xCrc,decodeSht3x} from '../src/thermal/sht3x.ts';
const source=fileURLToPath(new URL('../../klippy/extras/sht3x.py',import.meta.url));
const python=`import importlib.util,types,sys,time,json,logging
logging.disable(logging.CRITICAL)
pkg=types.ModuleType('sht_reference');pkg.bus=types.ModuleType('sht_reference.bus');sys.modules['sht_reference']=pkg
spec=importlib.util.spec_from_file_location('sht_reference.sht3x',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
c=module.SHT3X.__new__(module.SHT3X)
frames=[]
for i in range(4096):
 t=i*7919%65536;h=i*104729%65536
 frames.append(bytes([t>>8,t&255,c._crc8(t),h>>8,h&255,c._crc8(h)]))
class Bus:
 def i2c_read(self,data,n,retry=False): return {'response':frames[self.index]}
 def get_mcu(self): return types.SimpleNamespace(estimated_print_time=lambda t:0)
c.i2c=Bus();c.reactor=types.SimpleNamespace(monotonic=lambda:0);c.report_time=1;c.min_temp=-45;c.max_temp=130;c._callback=lambda t,v:None;c._error=RuntimeError
values=[]
for i in range(4096):
 c.i2c.index=i;assert c._sample_sht3x(0)==1;values.append([c.temp,c.humidity])
c.i2c.index=123
start=time.perf_counter()
for i in range(100000): assert c._sample_sht3x(0)==1
ms=(time.perf_counter()-start)*1000
print(json.dumps({'ms':ms,'values':values,'crc':bytes(c._crc8(i) for i in range(65536)).hex()}))`;
const frames=Array.from({length:4096},(_,i)=>{const t=i*7919%65536,h=i*104729%65536;return Uint8Array.of(t>>>8,t&255,sht3xCrc(t),h>>>8,h&255,sht3xCrc(h));});
const baseline:number[]=[],current:number[]=[],signal=new AbortController().signal;
for(let round=0;round<8;round++)for(const which of round%2?['current','python']:['python','current']){
 let ms:number;
 if(which==='python'){
  const result=JSON.parse(execFileSync('python3',['-c',python,source],{encoding:'utf8',maxBuffer:2**20}));ms=result.ms;
  assert.equal(Buffer.from(Array.from({length:65536},(_,i)=>sht3xCrc(i))).toString('hex'),result.crc);
  assert.deepEqual(frames.map(f=>{const r=decodeSht3x(f);return [r.temperature,r.humidity];}),result.values);
 }else{
  let time=0;const sensor=new Sht3xSensor({async transfer(_bytes,n){return n===3?Uint8Array.of(0,0,sht3xCrc(0)):n===6?frames[123]:Buffer.alloc(0);}},async ms=>{time+=ms;},()=>time);await sensor.initialize(signal);
  const start=performance.now();for(let i=0;i<100000;i++)await sensor.sample(signal);ms=performance.now()-start;
 }
 if(round>=3)(which==='python'?baseline:current).push(ms);
}
const stats=(samplesMs:number[])=>({samplesMs,medianMs:[...samplesMs].sort((a,b)=>a-b)[2]});
const result={runtime:process.version,scope:'100000 original Python sample callbacks vs TS async driver samples with fake I2C; Python includes range/callback/report handling, TS excludes periodic owner; no electrical IO; 4096 values and all 65536 CRCs match; 3 warmups and 5 alternating retained rounds',baseline:stats(baseline),current:stats(current)};
console.log(JSON.stringify(result,null,2));if(result.current.medianMs>result.baseline.medianMs*1.1)throw Error('SHT3X driver performance regression');
