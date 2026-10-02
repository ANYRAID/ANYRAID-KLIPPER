import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {cpus} from 'node:os';
import {MessageDictionary} from '../src/protocol/dictionary.ts';
import {compilePWM,PWMOutput} from '../src/outputs/pwm.ts';
const chip={},cases:{frequency:number;hardware:boolean;invert:0|1;start:number;shutdown:number;duration:number;cycle:number}[]=[],dictionaries:MessageDictionary[]=[];
for(const frequency of [1e6,48e6,168e6])for(const hardware of [false,true])for(const invert of [0,1] as const)for(const [start,shutdown,duration] of hardware?[[0,0,2],[.5,.5,2],[.5,0,0],[1,1,2]]:[[0,0,2],[1,1,2],[.5,0,0]])for(const cycle of [.0001234567,.0137,.1]){cases.push({frequency,hardware,invert,start,shutdown,duration,cycle});const d=new MessageDictionary();d.identify(Buffer.from(JSON.stringify({commands:{'config_pwm_out oid=%c pin=%u cycle_ticks=%u value=%hu default_value=%hu max_duration=%u':24,'queue_pwm_out oid=%c clock=%u value=%hu':25,'set_digital_out_pwm_cycle oid=%c cycle_ticks=%u':26,'config_digital_out oid=%c pin=%u value=%c default_value=%c max_duration=%u':21,'queue_digital_out oid=%c clock=%u on_ticks=%u':23},responses:{},config:{CLOCK_FREQ:frequency,PWM_MAX:255}})),false);dictionaries.push(d);}
const samples:number[]=[],results:unknown[]=[];
for(let run=0;run<14;run++){const begin=performance.now();for(let i=0;i<cases.length;i++){const c=cases[i],d=dictionaries[i],clock=(t:number)=>BigInt(Math.trunc(t*c.frequency)),config=compilePWM(chip,d,{oid:3,pin:{chip,chipName:'mcu',pin:'PA0',invert:c.invert,pullup:0},hardware:c.hardware,cycleTime:c.cycle,maxDuration:c.duration,start:c.start,shutdown:c.shutdown,currentPrintTime:1},clock),writes:unknown[]=[],aligned:number[][]=[];const output=new PWMOutput(config,d,{async send(data,min,req){writes.push([String(min),String(req),Buffer.from(data).toString('hex')]);},async stop(){}},clock,t=>Number(t)/c.frequency);for(let j=0;j<50;j++){const t=1.3+j*.0213;aligned.push([output.nextAlignedPrintTime(t,.004),output.nextAlignedPrintTime(t-.3,.04)]);await output.setPWM(t,[0,.00001,.5,1,.3333][j%5],new AbortController().signal);}if(run===0)results.push({commands:config.commands,restart:config.restart,init:config.init,slots:config.reservedMoves,writes,aligned});}if(run>=3)samples.push(performance.now()-begin);}samples.sort((a,b)=>a-b);
const python=String.raw`
import ast,sys,json,types,time,os
sys.path.insert(0,os.path.dirname(sys.argv[1]));import msgproto
source=open(sys.argv[1]).read();cls=next(n for n in ast.parse(source).body if isinstance(n,ast.ClassDef) and n.name=='MCU_pwm');MAX_SCHEDULE_TICKS=(1<<31)-1;pins=types.SimpleNamespace(error=ValueError);exec(ast.get_source_segment(source,cls),globals());cases=json.load(sys.stdin)
def run(c):
 commands=[];restart=[];init=[];slots=[];writes=[];aligned=[]
 wire=msgproto.MessageFormat([25] if c['hardware'] else [23],'queue_pwm_out oid=%c clock=%u value=%hu' if c['hardware'] else 'queue_digital_out oid=%c clock=%u on_ticks=%u')
 def send(params,minclock,reqclock):writes.append([str(minclock),str(reqclock),bytes(wire.encode(params)).hex()])
 def config(cmd,on_restart=False,is_init=False):(restart if on_restart else init if is_init else commands).append(cmd)
 mcu=types.SimpleNamespace(register_config_callback=lambda cb:None,seconds_to_clock=lambda t:int(t*c['frequency']),request_move_queue_slot=lambda:slots.append(1),create_oid=lambda:3,add_config_cmd=config,alloc_command_queue=lambda:0,lookup_command=lambda *a,**k:types.SimpleNamespace(send=send),get_constant_float=lambda n:255,print_time_to_clock=lambda t:int(t*c['frequency']),clock_to_print_time=lambda clk:clk/c['frequency'],get_printer=lambda:types.SimpleNamespace(get_reactor=lambda:types.SimpleNamespace(monotonic=lambda:0)),estimated_print_time=lambda t:1)
 p=MCU_pwm(mcu,{'pin':'PA0','invert':c['invert']});p.setup_cycle_time(c['cycle'],c['hardware']);p.setup_max_duration(c['duration']);p.setup_start_value(c['start'],c['shutdown']);p._build_config()
 for j in range(50):
  t=1.3+j*.0213;aligned.append([p.next_aligned_print_time(t,.004),p.next_aligned_print_time(t-.3,.04)]);p.set_pwm(t,[0,.00001,.5,1,.3333][j%5])
 return {'commands':commands,'restart':restart,'init':init,'slots':len(slots),'writes':writes,'aligned':aligned}
samples=[];result=None
for repeat in range(14):
 t=time.perf_counter();result=[run(c) for c in cases]
 if repeat>=3:samples.append((time.perf_counter()-t)*1000)
print(json.dumps({'python':sys.version.split()[0],'results':result,'samples':sorted(samples)}))
`;
const p=spawnSync('/usr/bin/python3',['-c',python,fileURLToPath(new URL('../../klippy/mcu.py',import.meta.url))],{input:JSON.stringify(cases),encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024});assert.equal(p.status,0,p.stderr||String(p.error));const reference=JSON.parse(p.stdout);assert.deepEqual(results,reference.results);
console.log(JSON.stringify({node:process.version,python:reference.python,cpu:cpus()[0].model,cases:cases.length,updates:cases.length*50,alignments:cases.length*100,identical:true,nodeMedianMs:samples[5],nodeP95Ms:samples[10],pythonMedianMs:reference.samples[5],pythonP95Ms:reference.samples[10],scope:'Original Python MCU_pwm and msgproto; configuration, scheduling clocks, payloads and positive/negative alignment deltas. Mocked transport; no PWM electrical or hardware deadline claim.'},null,2));
