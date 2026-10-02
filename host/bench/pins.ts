import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {cpus} from 'node:os';
import {PinResolver,PrinterPins} from '../src/protocol/pins.ts';
const commands=Array.from({length:10000},(_,i)=>`config oid=${i%100} step_pin=STEP${i%100} dir_pin=PB${i%100}`),times:number[]=[];let hash='';
for(let run=0;run<14;run++){const p=new PinResolver();for(let i=0;i<100;i++)p.alias(`STEP${i}`,`PA${i}`);const start=performance.now(),result=p.resolve(commands);if(run>=3)times.push(performance.now()-start);hash=createHash('sha256').update(result.join('\n')).digest('hex');}times.sort((a,b)=>a-b);
const descriptors=['PA0','!PA0','^PA0','~!aux:PB2',' ^ ! PA3 ','bad:PA0','!^PA0'];const registry=new PrinterPins<object>();registry.register('mcu',{});registry.register('aux',{});const parsed=descriptors.map(d=>{try{const p=registry.parse(d,{canInvert:true,canPullup:true});return [p.chipName,p.pin,p.invert,p.pullup];}catch{return null;}});
const python=String.raw`
import runpy,sys,time,json,hashlib
m=runpy.run_path(sys.argv[1]);commands=['config oid=%d step_pin=STEP%d dir_pin=PB%d'%(i%100,i%100,i%100) for i in range(10000)];times=[]
for run in range(14):
 p=m['PinResolver']()
 for i in range(100):p.alias_pin('STEP%d'%i,'PA%d'%i)
 start=time.perf_counter();result=[p.update_command(c) for c in commands]
 if run>=3:times.append((time.perf_counter()-start)*1000)
hash=hashlib.sha256('\n'.join(result).encode()).hexdigest();p=m['PrinterPins']();p.register_chip('mcu',object());p.register_chip('aux',object());parsed=[]
for d in ['PA0','!PA0','^PA0','~!aux:PB2',' ^ ! PA3 ','bad:PA0','!^PA0']:
 try:
  v=p.parse_pin(d,True,True);parsed.append([v['chip_name'],v['pin'],v['invert'],v['pullup']])
 except m['error']:parsed.append(None)
print(json.dumps({'hash':hash,'parsed':parsed,'samples':sorted(times),'python':sys.version.split()[0]}))
`;
const p=spawnSync(process.env.PYTHON??'python3',['-c',python,fileURLToPath(new URL('../../klippy/pins.py',import.meta.url))],{encoding:'utf8',timeout:60000});assert.equal(p.status,0,p.stderr||String(p.error));const expected=JSON.parse(p.stdout);assert.equal(hash,expected.hash);assert.deepEqual(parsed,expected.parsed);
console.log(JSON.stringify({node:process.version,python:expected.python,cpu:cpus()[0].model,commands:commands.length,pinFields:commands.length*2,descriptorCases:descriptors.length,nodeMedianMs:times[5],nodeP95Ms:times[10],pythonMedianMs:expected.samples[5],pythonP95Ms:expected.samples[10],identical:true,scope:'Configuration-only pin translation. Node also stages alias usage atomically; no printer I/O.'},null,2));
