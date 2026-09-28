import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {decodeLm75,Lm75Sensor} from '../src/thermal/lm75.ts';
const source=fileURLToPath(new URL('../../klippy/extras/lm75.py',import.meta.url));
const python=`import importlib.util,types,sys,time,json
pkg=types.ModuleType('lm_reference');pkg.bus=types.ModuleType('lm_reference.bus');sys.modules['lm_reference']=pkg
spec=importlib.util.spec_from_file_location('lm_reference.lm75',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
c=module.LM75.__new__(module.LM75)
frames=[bytes([i>>8,i&255]) for i in range(65536)]
values=[c.degrees_from_sample(f) for f in frames]
checksum=0
start=time.perf_counter()
for i in range(1000000): checksum+=c.degrees_from_sample(frames[i%32768])
print(json.dumps({'values':values,'checksum':checksum,'ms':(time.perf_counter()-start)*1000}))`;
const frames=Array.from({length:65536},(_,i)=>Uint8Array.of(i>>>8,i&255)),baseline:number[]=[],current:number[]=[],driver:number[]=[],signal=new AbortController().signal;
let checksum=0;
for(let round=0;round<8;round++)for(const which of round%2?['ts','python']:['python','ts']){
 if(which==='python'){
  const value=JSON.parse(execFileSync('python3',['-c',python,source],{encoding:'utf8',maxBuffer:2**21}));
  for(let i=0;i<65536;i++)assert.equal(decodeLm75(frames[i]),value.values[i]-(i>=32768?256:0));
  checksum=value.checksum;if(round>=3)baseline.push(value.ms);
 }else{
  let sum=0;const start=performance.now();for(let i=0;i<1000000;i++)sum+=decodeLm75(frames[i%32768]);const elapsed=performance.now()-start;
  if(checksum)assert.equal(sum,checksum);if(round>=3)current.push(elapsed);
  let time=0;const sensor=new Lm75Sensor({async transfer(_b,n){return n===1?Uint8Array.of(0):frames[13056];}},async ms=>{time+=ms;},()=>time);await sensor.initialize(signal);
  const begin=performance.now();for(let i=0;i<100000;i++)await sensor.sample(signal);if(round>=3)driver.push(performance.now()-begin);
 }
}
const stats=(samplesMs:number[])=>({samplesMs,medianMs:[...samplesMs].sort((a,b)=>a-b)[2]});
const result={runtime:process.version,scope:'1 million decode-only calls on the identical positive-domain sequence; all 65536 register words compared separately; 3 warmups and 5 alternating retained rounds',precision:{positiveWordsExactlyMatch:32768,negativeWordsCorrected:32768,legacyNegativeBiasDegrees:256,reference:'TI LM75A datasheet section 7.6.2 signed 9-bit two complement; lower seven bits ignored'},baseline:stats(baseline),current:stats(current),driver:{...stats(driver),samples:100000,scope:'async driver with fake I2C and virtual waits; not physical throughput or Python driver comparison',maximumAllowedMicrosecondsPerSample:10},checksum};
console.log(JSON.stringify(result,null,2));assert(result.current.medianMs<=result.baseline.medianMs*1.1,'conversion regression');assert(result.driver.medianMs/100<=10,'async driver overhead exceeds budget');
