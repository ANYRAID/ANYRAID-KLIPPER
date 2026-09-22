// Differential reference: execute original MCU_endstop, without printer I/O.
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {MessageDictionary} from '../src/protocol/dictionary.ts';
import {EndstopProtocol,endstopFormats} from '../src/inputs/endstop.ts';
const source=String.raw`
import ast,pathlib,sys,json,time,types
text=pathlib.Path(sys.argv[1]).read_text()
node=next(n for n in ast.parse(text).body if isinstance(n,ast.ClassDef) and n.name=='MCU_endstop')
class MCU_trsync: REASON_ENDSTOP_HIT=1; REASON_COMMS_TIMEOUT=4
exec(ast.get_source_segment(text,node))
data=json.load(sys.stdin);out=[]
class Command:
 def send(self,args,**kwargs): self.last=args;return {'pin_value':1,'next_clock':m.next & 0xffffffff}
class MCU:
 def print_time_to_clock(self,t):return int(t*12000000.)
 def seconds_to_clock(self,t):return int(t*12000000.)
 def is_fileoutput(self):return False
 def clock32_to_clock64(self,c):return self.next
 def clock_to_print_time(self,c):return c/12000000.
m=MCU();e=MCU_endstop.__new__(MCU_endstop);e._mcu=m;e._oid=7;e._home_cmd=Command();e._query_cmd=Command();e._invert=1
e._dispatch=types.SimpleNamespace(start=lambda t:None,get_oid=lambda:8,wait_end=lambda t:None,stop=lambda:1)
m.next=0
for p in data:
 e._invert=p['invert'];e.home_start(p['time'],p['sample'],p['count'],p['rest'],p['triggered'])
 command=e._home_cmd.last
 m.next=command[1]+command[4]+19
 out.append({'command':command,'hitTime':e.home_wait(p['time']+1.)})
def run():
 total=0
 for i in range(100000):total+=e.query_endstop(2.)
 return total
for _ in range(3):run()
times=[]
for _ in range(11):
 start=time.perf_counter();run();times.append((time.perf_counter()-start)*1000)
print(json.dumps({'commands':out,'times':sorted(times)}))
`;
const cases=Array.from({length:1000},(_,i)=>({time:2+i*400,sample:.000015,count:1+i%8,rest:.0001+(i%20)*.00001,invert:i%2,triggered:i%3===0}));
const ref=spawnSync(process.env.PYTHON??'python3',['-c',source,fileURLToPath(new URL('../../klippy/mcu.py',import.meta.url))],{input:JSON.stringify(cases),encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
if(ref.status!==0)throw new Error(ref.stderr||String(ref.error));
const oracle=JSON.parse(ref.stdout) as {commands:{command:number[];hitTime:number}[];times:number[]};
const dictionary=new MessageDictionary();dictionary.identify(Buffer.from(JSON.stringify({commands:{[endstopFormats.config]:2,[endstopFormats.home]:3,[endstopFormats.query]:4},responses:{[endstopFormats.state]:5},config:{CLOCK_FREQ:12000000},enumerations:{pin:{PA1:17}}})),false);
const chip={};const protocols=([0,1] as const).map(invert=>new EndstopProtocol(chip,dictionary,7,{chip,chipName:'mcu',pin:'PA1',invert,pullup:1}));
for(const [index,p] of cases.entries()){
 const plan=protocols[p.invert].home({printTime:p.time,sampleTime:p.sample,sampleCount:p.count,restTime:p.rest,trsyncOid:8,triggered:p.triggered},t=>BigInt(Math.trunc(t*12000000)));
 const [oid,clock,sample_ticks,sample_count,rest_ticks,pin_value,trsync_oid,trigger_reason]=oracle.commands[index].command;
 assert.equal(plan.reqClock,BigInt(clock));assert.equal(plan.restTicks,BigInt(rest_ticks));
 assert.deepEqual(plan.payload,dictionary.encode('endstop_home',{oid,clock:Number(BigInt.asUintN(32,BigInt(clock))),sample_ticks,sample_count,rest_ticks,pin_value,trsync_oid,trigger_reason}));
 const next=plan.reqClock+plan.restTicks+19n;
 const state=protocols[p.invert].decode({name:'endstop_state',parameters:{oid:7,homing:0,pin_value:0,next_clock:Number(BigInt.asUintN(32,next))}})!;
 assert.equal(Number(protocols[p.invert].hitClock(state,plan,()=>next))/12000000,oracle.commands[index].hitTime);
}
const protocol=protocols[cases.at(-1)!.invert],message={name:'endstop_state',parameters:{oid:7,homing:0,pin_value:1,next_clock:0}};
function run(){let total=0;for(let i=0;i<100000;i++)total+=Number(protocol.decode(message)!.triggered);return total;}
for(let i=0;i<3;i++)run();const times=[];for(let i=0;i<11;i++){const start=performance.now();run();times.push(performance.now()-start);}times.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,exactSamplingCases:cases.length,reports:100000,nodeMedianMs:times[5],nodeP95Ms:times[10],pythonMedianMs:oracle.times[5],pythonP95Ms:oracle.times[10],scope:'Node validated response decoding vs original Python query_endstop with mocked query and clock; excludes transport, trigger dispatch and hardware'},null,2));
assert.ok(times[5]<oracle.times[5],'Endstop response processing regression');
