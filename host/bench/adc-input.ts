import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {cpus} from 'node:os';
import {MessageDictionary} from '../src/protocol/dictionary.ts';
import {compileADC,ADCInput,legacyADCQuery,batchADCQuery} from '../src/inputs/adc.ts';
const chip={},cases:{frequency:number;sampleCount:number;batchCount:number;legacy:boolean}[]=[];
for(const frequency of [1e6,48e6,168e6])for(const sampleCount of [1,4,8])for(const [batchCount,legacy] of [[1,true],[1,false],[3,false],[24,false]] as const)cases.push({frequency,sampleCount,batchCount,legacy});
const contexts=cases.map(c=>{const d=new MessageDictionary();d.identify(Buffer.from(JSON.stringify({commands:{'config_analog_in oid=%c pin=%u':27,[c.legacy?legacyADCQuery:batchADCQuery]:28},responses:{[c.legacy?'analog_in_state oid=%c next_clock=%u value=%hu':'analog_in_state oid=%c next_clock=%u values=%*s']:29},config:{CLOCK_FREQ:c.frequency,ADC_MAX:4095}})),false);return d;});
const results:unknown[]=[],samples:number[]=[];
for(let run=0;run<14;run++){const begin=performance.now();for(let i=0;i<cases.length;i++){
 const c=cases[i],config=compileADC(chip,contexts[i],{oid:3,pin:{chip,chipName:'mcu',pin:'PA0',invert:0,pullup:0},currentPrintTime:1,reportTime:.01,sampleTime:.0001,sampleCount:c.sampleCount,batchCount:c.batchCount,minimum:.123,maximum:.789,rangeCheckCount:4},t=>BigInt(Math.trunc(t*c.frequency))),reports:unknown[]=[];
 let full=0n;const input=new ADCInput(config,n=>full+BigInt.asIntN(32,BigInt(n)-full),n=>Number(n)/c.frequency,s=>reports.push(s));
 for(let j=0;j<100;j++){full=BigInt(2*c.frequency)+BigInt((j+1)*c.batchCount*config.reportTicks);const values=Array.from({length:c.batchCount},(_,k)=>(j*317+k*103)%config.maximumSum),next=Number(BigInt.asUintN(32,full));input.receive({name:'analog_in_state',parameters:c.legacy?{oid:3,next_clock:next,value:values[0]}:{oid:3,next_clock:next,values:Buffer.from(values.flatMap(v=>[v&255,v>>8]))}});}
 if(run===0)results.push({commands:config.commands,init:config.init,reports,last:input.lastValue});
 }if(run>=3)samples.push(performance.now()-begin);}samples.sort((a,b)=>a-b);
const python=String.raw`
import ast,sys,json,types,time,math,struct,copy
source=open(sys.argv[1]).read();cls=next(n for n in ast.parse(source).body if isinstance(n,ast.ClassDef) and n.name=='MCU_adc');exec(ast.get_source_segment(source,cls),globals());cases=json.load(sys.stdin)
def run(c,verify=False):
 commands=[];init=[];reports=[];full=0
 def config(cmd,is_init=False):(init if is_init else commands).append(cmd)
 mcu=types.SimpleNamespace(register_config_callback=lambda cb:None,create_oid=lambda:3,add_config_cmd=config,get_query_slot=lambda oid:2*c['frequency']+int(oid*.01*c['frequency']),seconds_to_clock=lambda t:int(t*c['frequency']),get_constant_float=lambda n:4095,try_lookup_command=lambda cmd:True if c['legacy'] else None,register_serial_response=lambda *a:None,clock32_to_clock64=lambda n:full+((n-full+(1<<31))%(1<<32)-(1<<31)),clock_to_print_time=lambda n:n/c['frequency'])
 p=MCU_adc(mcu,{'pin':'PA0'});p.setup_adc_sample(.01,.0001,c['sampleCount'],c['batchCount'],.123,.789,4);p.setup_adc_callback(reports.append);p._build_config()
 # The original <H unpack_from reads one sample regardless of report length.
 # Correct only that decoder for equal-work timing; retain original clock/math.
 p._unpack_from=lambda b:tuple(v[0] for v in struct.iter_unpack('<H',b))
 if verify:
  scalar=copy.copy(p);individual=[];scalar.setup_adc_callback(lambda s:individual.extend(s))
 for j in range(100):
  full=2*c['frequency']+(j+1)*c['batchCount']*p._report_clock
  values=[(j*317+k*103)%(4095*c['sampleCount']) for k in range(c['batchCount'])]
  if c['legacy']:p._old_handle_analog_in_state({'value':values[0],'next_clock':full&0xffffffff})
  else:p._handle_analog_in_state({'values':struct.pack('<'+'H'*len(values),*values),'next_clock':full&0xffffffff})
  if verify:
   individual.clear()
   for k,value in enumerate(values):scalar._old_handle_analog_in_state({'value':value,'next_clock':(full-(len(values)-1-k)*p._report_clock)&0xffffffff})
   assert individual==reports[-1]
 return {'commands':commands,'init':init,'reports':reports,'last':p.get_last_value()}
samples=[]
for repeat in range(14):
 t=time.perf_counter();results=[run(c) for c in cases]
 if repeat>=3:samples.append((time.perf_counter()-t)*1000)
for c in cases:run(c,True)
print(json.dumps({'python':sys.version.split()[0],'results':results,'samples':sorted(samples),'originalDecodedSamples':len(struct.Struct('<H').unpack_from(bytes(48)))}))
`;
const p=spawnSync('/usr/bin/python3',['-c',python,fileURLToPath(new URL('../../klippy/mcu.py',import.meta.url))],{input:JSON.stringify(cases),encoding:'utf8',timeout:60000,maxBuffer:32*1024*1024});assert.equal(p.status,0,p.stderr||String(p.error));const reference=JSON.parse(p.stdout);assert.deepEqual(results,reference.results);assert.equal(reference.originalDecodedSamples,1);
console.log(JSON.stringify({node:process.version,python:reference.python,cpu:cpus()[0].model,cases:cases.length,reports:cases.length*100,readings:cases.reduce((n,c)=>n+c.batchCount*100,0),identical:true,originalBatchBug:{bytes:48,decoded:reference.originalDecodedSamples,required:24},nodeMedianMs:samples[5],nodeP95Ms:samples[10],pythonMedianMs:reference.samples[5],pythonP95Ms:reference.samples[10],scope:'Original MCU_adc config/math; Python batch decoder corrected to iter_unpack for equal work. Simulated messages and clock mapping, no sensor hardware claim.'},null,2));
