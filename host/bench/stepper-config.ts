import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {cpus} from 'node:os';
import {MessageDictionary} from '../src/protocol/dictionary.ts';
import {PrinterPins} from '../src/protocol/pins.ts';
import {compileStepper} from '../src/motion/stepper-config.ts';
const chip={},pins=new PrinterPins<object>();pins.register('mcu',chip);const base={oid:3,step:pins.lookup('!PA0',{canInvert:true}),direction:pins.lookup('!PA1',{canInvert:true}),rotationDistance:40,stepsPerRotation:3200};
const cases:{frequency:number;ssbe:number;sbe:number;sou:number;duration:number|null;request:boolean}[]=[],dictionaries:MessageDictionary[]=[];
for(const frequency of [1e6,48e6,168e6])for(const ssbe of [0,1])for(const sbe of [0,1])for(const sou of [0,1])for(const duration of [null,0,1e-7,1.5e-7,1.51e-7,5e-7,5.01e-7,2e-6,.01])for(const request of [false,true]){cases.push({frequency,ssbe,sbe,sou,duration,request});const d=new MessageDictionary();d.identify(Buffer.from(JSON.stringify({commands:{'queue_step oid=%c interval=%u count=%hu add=%hi':2,'set_next_step_dir oid=%c dir=%c':3,'reset_step_clock oid=%c clock=%u':4,'stepper_get_position oid=%c':5},responses:{'stepper_position oid=%c pos=%i':6},config:{CLOCK_FREQ:frequency,STEPPER_STEP_BOTH_EDGE:ssbe,STEPPER_BOTH_EDGE:sbe,STEPPER_OPTIMIZED_UNSTEP:sou}})),false);dictionaries.push(d);}
const times:number[]=[],actual:unknown[]=[];
for(let run=0;run<14;run++){const start=performance.now();for(let i=0;i<cases.length;i++){const c=cases[i],p=compileStepper(chip,dictionaries[i],{...base,pulseDuration:c.duration??undefined,requestBothEdges:c.request});if(run===0)actual.push([p.config,p.restart,p.pulseDuration,p.bothEdges,p.compressor.maxError]);}if(run>=3)times.push(performance.now()-start);}times.sort((a,b)=>a-b);
const python=String.raw`
import ast,sys,json,types,time,textwrap
source=open(sys.argv[1]).read();cls=next(n for n in ast.parse(source).body if isinstance(n,ast.ClassDef) and n.name=='MCU_stepper');node=next(n for n in cls.body if isinstance(n,ast.FunctionDef) and n.name=='_build_config');exec(textwrap.dedent(ast.get_source_segment(source,node)),globals())
MIN_BOTH_EDGE_DURATION=.000000500;MIN_OPTIMIZED_BOTH_EDGE_DURATION=.000000150;MAX_STEPCOMPRESS_ERROR=.000025
cases=json.load(sys.stdin);current=[];chelper=types.SimpleNamespace(get_ffi=lambda:(None,types.SimpleNamespace(stepcompress_fill=lambda q,oid,err,s,d:current.append(err))))
def run(c):
 commands=[];tags={'queue_step':2,'set_next_step_dir':3,'reset_step_clock':4}
 mcu=types.SimpleNamespace(get_constants=lambda:{'STEPPER_STEP_BOTH_EDGE':c['ssbe'],'STEPPER_BOTH_EDGE':c['sbe'],'STEPPER_OPTIMIZED_UNSTEP':c['sou']},get_printer=lambda:types.SimpleNamespace(lookup_object=lambda name:types.SimpleNamespace(deprecate_mcu_code=lambda *args:None)),seconds_to_clock=lambda t:int(t*c['frequency']),add_config_cmd=lambda cmd,**kw:commands.append(cmd),lookup_command=lambda fmt:types.SimpleNamespace(get_command_tag=lambda:tags[fmt.split()[0]]),lookup_query_command=lambda *args,**kw:None)
 s=types.SimpleNamespace(_mcu=mcu,_step_pulse_duration=c['duration'],_invert_step=1,_req_step_both_edge=c['request'],_step_both_edge=False,_oid=3,_step_pin='PA0',_dir_pin='PA1',_stepqueue=None);_build_config(s)
 return [*commands,s._step_pulse_duration,s._step_both_edge,current.pop()]
expected=[run(c) for c in cases];samples=[]
for r in range(14):
 start=time.perf_counter()
 for c in cases:run(c)
 if r>=3:samples.append((time.perf_counter()-start)*1000)
print(json.dumps({'results':expected,'samples':sorted(samples),'python':sys.version.split()[0]}))
`;
const p=spawnSync(process.env.PYTHON??'python3',['-c',python,fileURLToPath(new URL('../../klippy/stepper.py',import.meta.url))],{input:JSON.stringify(cases),encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});assert.equal(p.status,0,p.stderr||String(p.error));const reference=JSON.parse(p.stdout);assert.deepEqual(actual,reference.results);
console.log(JSON.stringify({node:process.version,python:reference.python,cpu:cpus()[0].model,cases:cases.length,identical:true,nodeMedianMs:times[5],nodeP95Ms:times[10],pythonMedianMs:reference.samples[5],pythonP95Ms:reference.samples[10],scope:'Configuration generation only. Original Python _build_config with mocked MCU/FFI; no electrical pulse measurement.'},null,2));
