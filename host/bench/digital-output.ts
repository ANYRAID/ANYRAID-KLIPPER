import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {cpus} from 'node:os';
import {MessageDictionary} from '../src/protocol/dictionary.ts';
import {compileDigital,DigitalOutput} from '../src/outputs/digital.ts';
const chip={},cases:{frequency:number;invert:0|1;start:boolean;shutdown:boolean;duration:number}[]=[],dictionaries:MessageDictionary[]=[];
for(const frequency of [1e6,48e6,168e6])for(const invert of [0,1] as const)for(const start of [false,true])for(const shutdown of [false,true])for(const duration of [0,1/frequency,.01,2]){if(duration&&start!==shutdown)continue;cases.push({frequency,invert,start,shutdown,duration});const d=new MessageDictionary();d.identify(Buffer.from(JSON.stringify({commands:{'config_digital_out oid=%c pin=%u value=%c default_value=%c max_duration=%u':21,'update_digital_out oid=%c value=%c':22,'queue_digital_out oid=%c clock=%u on_ticks=%u':23},responses:{},config:{CLOCK_FREQ:frequency}})),false);dictionaries.push(d);}
const times:number[]=[],results:unknown[]=[];
for(let run=0;run<14;run++){const startTime=performance.now();for(let i=0;i<cases.length;i++){const c=cases[i],d=dictionaries[i],compiled=compileDigital(chip,d,{oid:3,pin:{chip,chipName:'mcu',pin:'PA0',pullup:0,invert:c.invert},start:c.start,shutdown:c.shutdown,maxDuration:c.duration});const writes:unknown[]=[];const output=new DigitalOutput(compiled,d,{async send(data,min,req){writes.push([String(min),String(req),Buffer.from(data).toString('hex')]);},async stop(){}},t=>BigInt(Math.trunc(t*c.frequency)));for(let j=0;j<100;j++)await output.setDigital(1+j*.001,j%2===0,new AbortController().signal);if(run===0)results.push({config:compiled.config,restart:compiled.restart,slots:compiled.reservedMoves,writes});}if(run>=3)times.push(performance.now()-startTime);}times.sort((a,b)=>a-b);
const python=String.raw`
import ast,sys,json,types,time,os
sys.path.insert(0,os.path.dirname(sys.argv[1]));import msgproto
wire=msgproto.MessageFormat([23],"queue_digital_out oid=%c clock=%u on_ticks=%u")
source=open(sys.argv[1]).read();tree=ast.parse(source);cls=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='MCU_digital_out');MAX_SCHEDULE_TICKS=(1<<31)-1;pins=types.SimpleNamespace(error=ValueError);exec(ast.get_source_segment(source,cls),globals())
cases=json.load(sys.stdin)
def run(c):
 commands=[];writes=[];slots=[]
 def send(params,minclock,reqclock):writes.append([str(minclock),str(reqclock),bytes(wire.encode(params)).hex()])
 mcu=types.SimpleNamespace(register_config_callback=lambda cb:None,seconds_to_clock=lambda t:int(t*c['frequency']),request_move_queue_slot=lambda:slots.append(1),create_oid=lambda:3,add_config_cmd=lambda cmd,on_restart=False:commands.append(cmd),alloc_command_queue=lambda:0,lookup_command=lambda *args,**kw:types.SimpleNamespace(send=send),print_time_to_clock=lambda t:int(t*c['frequency']))
 p=MCU_digital_out(mcu,{'pin':'PA0','invert':c['invert']});p.setup_max_duration(c['duration']);p.setup_start_value(c['start'],c['shutdown']);p._build_config()
 for j in range(100):p.set_digital(1+j*.001,j%2==0)
 return {'config':commands[0],'restart':commands[1],'slots':len(slots),'writes':writes}
samples=[];result=None
for repeat in range(14):
 t=time.perf_counter();result=[run(c) for c in cases]
 if repeat>=3:samples.append((time.perf_counter()-t)*1000)
print(json.dumps({'python':sys.version.split()[0],'results':result,'samples':sorted(samples)}))
`;
const p=spawnSync('/usr/bin/python3',['-c',python,fileURLToPath(new URL('../../klippy/mcu.py',import.meta.url))],{input:JSON.stringify(cases),encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});assert.equal(p.status,0,p.stderr||String(p.error));const reference=JSON.parse(p.stdout);assert.deepEqual(results,reference.results);
console.log(JSON.stringify({node:process.version,python:reference.python,cpu:cpus()[0].model,cases:cases.length,updates:cases.length*100,identical:true,nodeMedianMs:times[5],nodeP95Ms:times[10],pythonMedianMs:reference.samples[5],pythonP95Ms:reference.samples[10],scope:'Original Python MCU_digital_out configuration and scheduling, including wire payload comparison; mocked MCU transport. TS includes per-call AbortController and async delivery handling; not physical GPIO latency.'},null,2));
