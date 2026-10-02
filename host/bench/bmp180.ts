import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {isAbsolute} from 'node:path';
import assert from 'node:assert/strict';
import {bmp180Fixtures} from '../contracts/bmp180-fixtures.ts';
import {Bmp180Compensation} from '../src/thermal/bmp180.ts';
const fixtures=bmp180Fixtures(),input=JSON.stringify(fixtures.map(f=>({bytes:[...f.bytes],samples:f.samples}))),source=fileURLToPath(new URL('../../klippy/extras/bme280.py',import.meta.url));
const python=`import importlib.util,types,sys,time,json,logging
logging.disable(logging.CRITICAL)
pkg=types.ModuleType('bme_reference');pkg.bus=types.ModuleType('bme_reference.bus');sys.modules['bme_reference']=pkg
spec=importlib.util.spec_from_file_location('bme_reference.bme',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
fixtures=json.load(sys.stdin);values=[];calibrations=[];objects=[]
for f in fixtures:
 c=module.BME280.__new__(module.BME280);c.read_id=lambda:0x55;c.read_register=lambda name,n:bytes(f['bytes']);c.write_register=lambda *args:None
 c.reactor=types.SimpleNamespace(monotonic=lambda:0,pause=lambda t:None,register_timer=lambda cb:None);c.os_temp=c.os_pres=c.os_hum=2;c.iir_filter=1;c.i2c=types.SimpleNamespace(i2c_address=119)
 c._init_bmxx80();objects.append(c);calibrations.append(c.dig)
 def decode(c,s):
  c.os_pres=s['oss'];return {'temperature':c._compensate_temp_bmp180(s['t']),'pressure':c._compensate_pressure_bmp180(s['p'])/100}
 values.append([decode(c,s) for s in f['samples']])
c=objects[0];samples=fixtures[0]['samples'];total=0.;start=time.perf_counter()
for i in range(100000):
 r=decode(c,samples[i%256]);total+=r['temperature']+r['pressure']
print(json.dumps({'ms':(time.perf_counter()-start)*1000,'values':values,'calibrations':calibrations,'checksum':total}))`;
const args=process.argv.slice(2),capture=args[0]==='--capture-reference'&&args.length===2?args[1]:undefined;if(args.length&&(!capture||!isAbsolute(capture)))throw Error('Use --capture-reference /absolute/new/file.json.gz');
const baseline:number[]=[],current:number[]=[];let checksum:number|undefined;
for(let round=0;round<8;round++)for(const mode of round%2?['ts','python']:['python','ts']){
 let ms:number,total:number;
 if(mode==='python'){
  const r=JSON.parse(execFileSync('python3',['-c',python,source],{input,encoding:'utf8',maxBuffer:4*1024**2}));ms=r.ms;total=r.checksum;
  for(let i=0;i<fixtures.length;i++){const f=fixtures[i],c=new Bmp180Compensation(f.bytes);assert.deepEqual(c.calibration,r.calibrations[i]);for(let j=0;j<f.samples.length;j++){const s=f.samples[j];assert.deepEqual(c.decode(s.t,s.p,s.oss),r.values[i][j]);}}
  if(capture){const hash=(x:string|Uint8Array)=>createHash('sha256').update(x).digest('hex');writeFileSync(capture,gzipSync(JSON.stringify({sourceSha256:hash(readFileSync(source)),inputSha256:hash(input),values:r.values,calibrations:r.calibrations})),{flag:'wx'});console.log(JSON.stringify({reference:capture,readings:8192}));process.exit(0);}
 }else{const f=fixtures[0],c=new Bmp180Compensation(f.bytes);total=0;const start=performance.now();for(let i=0;i<100000;i++){const s=f.samples[i%256],r=c.decode(s.t,s.p,s.oss);total+=r.temperature+r.pressure;}ms=performance.now()-start;}
 if(checksum!==undefined)assert.equal(total,checksum);checksum=total;if(round>=3)(mode==='python'?baseline:current).push(ms);
}
const stats=(samplesMs:number[])=>({samplesMs,medianMs:[...samplesMs].sort((a,b)=>a-b)[2]});const result={runtime:process.version,scope:'100000 paired compensations; 3 warmups and 5 alternating retained rounds; excludes IO and runtime callbacks',calibrationsExactlyMatched:32,readingsExactlyMatched:8192,checksum,baseline:stats(baseline),current:stats(current)};console.log(JSON.stringify(result,null,2));assert(result.current.medianMs<=result.baseline.medianMs*1.1,'BMP180 compensation regression');
