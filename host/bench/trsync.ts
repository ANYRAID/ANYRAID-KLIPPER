import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {MessageDictionary} from '../src/protocol/dictionary.ts';
import {TriggerSyncProtocol,trsyncFormats} from '../src/inputs/trsync.ts';
const firmware={commands:{[trsyncFormats.config]:2,[trsyncFormats.start]:3,[trsyncFormats.timeout]:4,[trsyncFormats.trigger]:5,[trsyncFormats.stepper]:6},responses:{[trsyncFormats.state]:7},config:{CLOCK_FREQ:12000000}};
const cases=Array.from({length:1000},(_,i)=>({clock:(i%2?2**40:0)+i*1000000,timeout:i%2?.025:.25,offset:(i%7)/7,steppers:Array.from({length:1+i%4},(_,j)=>j+1)}));
const source=String.raw`
import ast,pathlib,sys,json,time,types
root=pathlib.Path(sys.argv[1]);sys.path.insert(0,str(root));import msgproto
data=json.load(sys.stdin);parser=msgproto.MessageParser();parser.process_identify(json.dumps(data['firmware']).encode(),decompress=False)
text=(root/'mcu.py').read_text();node=next(n for n in ast.parse(text).body if isinstance(n,ast.ClassDef) and n.name=='MCU_trsync');exec(ast.get_source_segment(text,node))
class Command:
 def __init__(self,name):self.encoder=parser.messages_by_name[name]
 def send(self,args,**kwargs):
  raw=self.encoder.encode(args)
  packet={'data':raw,'min':kwargs.get('minclock',0),'req':kwargs.get('reqclock',0)}
  if verifying:
   values,end=self.encoder.parse(raw,0);assert end==len(raw)
   packet['canonical']=self.encoder.encode_by_name(**values)
  packets.append(packet)
class MCU:
 def print_time_to_clock(self,t):return start
 def seconds_to_clock(self,t):return int(t*12000000.)
 def register_serial_response(self,*args):return None
class FFI:
 def trdispatch_mcu_setup(self,*args):self.setup=args[1:]
ffi=FFI();chelper=types.SimpleNamespace(get_ffi=lambda:(None,ffi))
e=MCU_trsync.__new__(MCU_trsync);e._mcu=MCU();e._oid=8;e._trdispatch_mcu=None
for attr,name in [('_trsync_start_cmd','trsync_start'),('_stepper_stop_cmd','stepper_stop_on_trigger'),('_trsync_set_timeout_cmd','trsync_set_timeout')]:setattr(e,attr,Command(name))
steppers={i:types.SimpleNamespace(get_oid=lambda i=i:i) for i in range(1,5)}
def run(verify=False):
 global start,packets,verifying
 verifying=verify
 out=[]
 for p in data['cases']:
  start=p['clock'];packets=[];e._steppers=[steppers[i] for i in p['steppers']]
  e.start(0.,p['offset'],None,p['timeout']);out.append({'setup':ffi.setup,'packets':packets})
 return out
result=run(True)
for _ in range(3):run()
times=[]
for _ in range(11):
 startTime=time.perf_counter();run();times.append((time.perf_counter()-startTime)*1000)
print(json.dumps({'results':result,'times':sorted(times)}))
`;
const reference=spawnSync(process.env.PYTHON??'python3',['-c',source,fileURLToPath(new URL('../../klippy',import.meta.url))],{input:JSON.stringify({firmware,cases}),encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024});
if(reference.status!==0)throw new Error(reference.stderr||String(reference.error));
const oracle=JSON.parse(reference.stdout) as {results:{setup:number[];packets:{data:number[];canonical:number[];min:number;req:number}[]}[];times:number[]};
const dictionary=new MessageDictionary();dictionary.identify(Buffer.from(JSON.stringify(firmware)),false);const protocol=new TriggerSyncProtocol(dictionary,8);
function run(){return cases.map(p=>protocol.start(BigInt(p.clock),p.steppers,p.timeout,p.offset));}
for(const [index,plan] of run().entries()){
 assert.deepEqual([plan.startClock,plan.expireClock,plan.expireTicks,plan.minExtendTicks],oracle.results[index].setup.map(BigInt));
 assert.deepEqual(plan.packets.map(p=>({data:[...p.data],min:Number(p.min),req:Number(p.req)})),oracle.results[index].packets.map(p=>({data:p.canonical,min:p.min,req:p.req})));
 if(cases[index].clock<2**32)assert.deepEqual(plan.packets.map(p=>[...p.data]),oracle.results[index].packets.map(p=>p.data));
}
for(let i=0;i<3;i++)run();const samples=[];for(let i=0;i<11;i++){const start=performance.now();run();samples.push(performance.now()-start);}samples.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,plans:cases.length,nativeSetupAndDecodedWireValuesExact:true,lowClockBytesExact:true,extendedClockEncoding:'canonical low32; original Python may emit redundant leading groups',nodeMedianMs:samples[5],nodeP95Ms:samples[10],pythonMedianMs:oracle.times[5],pythonP95Ms:oracle.times[10],scope:'start preparation and encoding only; native dispatch, serial I/O, stop latency and hardware excluded'},null,2));
assert.ok(samples[5]<=oracle.times[5],'Trsync preparation regressed against original Python');
