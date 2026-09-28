import {writeFileSync,readFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {Bme280Compensation} from '../src/thermal/bme280-compensation.ts';
import {bme280Fixtures} from '../contracts/bme280-fixtures.ts';
const source=fileURLToPath(new URL('../../klippy/extras/bme280.py',import.meta.url)),fixtures=bme280Fixtures(),input=JSON.stringify(fixtures.map(f=>({first:[...f.first],second:f.second?[...f.second]:null,frames:f.frames.map(b=>[...b])})));
const python=`import importlib.util,types,sys,time,json,logging
logging.disable(logging.CRITICAL)
pkg=types.ModuleType('bme_reference');pkg.bus=types.ModuleType('bme_reference.bus');sys.modules['bme_reference']=pkg
spec=importlib.util.spec_from_file_location('bme_reference.bme',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
fixtures=json.load(sys.stdin)
values=[];calibrations=[];objects=[]
for f in fixtures:
 c=module.BME280.__new__(module.BME280);c.read_id=lambda:0x60 if f['second'] is not None else 0x58;c.read_register=lambda name,n:bytes(f['first'] if name=='CAL_1' else (f['second'] or [0]*16) if name=='CAL_2' else [0]);c.write_register=lambda *args:None
 c.reactor=types.SimpleNamespace(monotonic=lambda:0,pause=lambda t:None,register_timer=lambda cb:None);c.os_temp=c.os_pres=c.os_hum=2;c.iir_filter=1;c.i2c=types.SimpleNamespace(i2c_address=118)
 c._init_bmxx80();calibrations.append(c.dig);objects.append(c)
 def decode(c,b):
  t=(b[3]<<12)|(b[4]<<4)|(b[5]>>4);p=(b[0]<<12)|(b[1]<<4)|(b[2]>>4)
  result={'temperature':c._compensate_temp(t),'pressure':c._compensate_pressure_bme280(p)/100}
  if len(b)==8: result['humidity']=c._compensate_humidity_bme280((b[6]<<8)|b[7])
  return result
 values.append([decode(c,b) for b in f['frames']])
checksum=0.;c=objects[0];frames=fixtures[0]['frames'];start=time.perf_counter()
for i in range(100000):
 r=decode(c,frames[i%64]);checksum+=r['temperature']+r['pressure']+r['humidity']
print(json.dumps({'ms':(time.perf_counter()-start)*1000,'calibrations':calibrations,'values':values,'checksum':checksum}))`;
const args=process.argv.slice(2),capture=args.length===2&&args[0]==='--capture-reference'?args[1]:undefined;if(args.length&&(!capture||!isAbsolute(capture)))throw new Error('Use --capture-reference /absolute/new/file.json.gz');
const baseline:number[]=[],current:number[]=[];let checksum:number|undefined;
for(let round=0;round<8;round++)for(const which of round%2?['ts','python']:['python','ts']){
 let ms:number;
 if(which==='python'){
  const result=JSON.parse(execFileSync('python3',['-c',python,source],{input,encoding:'utf8',maxBuffer:2**21}));ms=result.ms;
  if(capture){const hash=(data:string|Uint8Array)=>createHash('sha256').update(data).digest('hex');writeFileSync(capture,gzipSync(JSON.stringify({sourceSha256:hash(readFileSync(source)),inputSha256:hash(input),calibrations:result.calibrations,values:result.values})),{flag:'wx'});console.log(JSON.stringify({reference:capture,calibrations:32,readings:2048}));process.exit(0);}
  for(let i=0;i<fixtures.length;i++){const f=fixtures[i],c=new Bme280Compensation(f.first,f.second);assert.deepEqual(c.calibration,result.calibrations[i]);for(let j=0;j<f.frames.length;j++)assert.deepEqual(c.decode(f.frames[j]),result.values[i][j]);}
  if(checksum!==undefined)assert.equal(result.checksum,checksum);checksum=result.checksum;
 }else{
  const f=fixtures[0],c=new Bme280Compensation(f.first,f.second);let total=0;const start=performance.now();for(let i=0;i<100000;i++){const r=c.decode(f.frames[i%64]);total+=r.temperature+r.pressure+r.humidity!;}ms=performance.now()-start;if(checksum!==undefined)assert.equal(total,checksum);checksum=total;
 }
 if(round>=3)(which==='python'?baseline:current).push(ms);
}
const stats=(samplesMs:number[])=>({samplesMs,medianMs:[...samplesMs].sort((a,b)=>a-b)[2]});const result={runtime:process.version,scope:'100000 temperature/pressure/humidity compensations including raw decoding; both exclude I2C and runtime owner; 3 warmups and 5 alternating retained rounds',calibrationSetsExactlyMatched:32,readingsExactlyMatched:2048,checksum,baseline:stats(baseline),current:stats(current)};console.log(JSON.stringify(result,null,2));assert(result.current.medianMs<=result.baseline.medianMs*1.1,'BME compensation regression');
