import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {crc32} from 'node:zlib';
import {cpus} from 'node:os';
import {MessageDictionary} from '../src/protocol/dictionary.ts';
import {configureMCU} from '../src/protocol/mcu-config.ts';
const definition={commands:{get_config:2,'allocate_oids count=%c':3,'finalize_config crc=%u':4,'config_stepper oid=%c pin=%u':5},responses:{'config is_config=%c crc=%u is_shutdown=%c move_count=%hu':6},enumerations:{pin:{PA0:[0,100]}}};
const dictionary=new MessageDictionary();dictionary.identify(Buffer.from(JSON.stringify(definition)),false);const commands=Array.from({length:100},(_,i)=>`config_stepper oid=${i} pin=PA${i}`),crc=crc32(Buffer.from(['allocate_oids count=100',...commands].join('\n'))),signal=new AbortController().signal,count=100,actual:string[]=[];
async function once(capture=false){let reads=0;return configureMCU(dictionary,{async query(){return {message:{name:'config',parameters:{is_config:reads++?1:0,crc,move_count:512,is_shutdown:0}},sentTime:1,receiveTime:1};},async send(p){if(capture)actual.push(Buffer.from(p).toString('hex'));},async stop(){throw new Error('Unexpected stop');}},{oidCount:100,commands},signal);}
assert.equal((await once(true)).crc,crc);const times:number[]=[];for(let run=0;run<14;run++){const start=performance.now();for(let i=0;i<count;i++)await once();if(run>=3)times.push(performance.now()-start);}times.sort((a,b)=>a-b);
const python=String.raw`
import ast,sys,json,zlib,types,time,textwrap
sys.path.insert(0,sys.argv[1]);import msgproto
source=open(sys.argv[1]+'/mcu.py').read();cls=next(n for n in ast.parse(source).body if isinstance(n,ast.ClassDef) and n.name=='MCUConfigHelper');method=next(n for n in cls.body if isinstance(n,ast.FunctionDef) and n.name=='_finalize_config');exec(textwrap.dedent(ast.get_source_segment(source,method)),globals())
data=json.load(sys.stdin);parser=msgproto.MessageParser();parser.process_identify(json.dumps(data['dictionary']).encode(),decompress=False)
pins=types.SimpleNamespace(get_pin_resolver=lambda name:types.SimpleNamespace(update_command=lambda cmd:cmd));printer=types.SimpleNamespace(lookup_object=lambda name:pins)
def once():
 s=types.SimpleNamespace(_config_callbacks=[],_config_cmds=list(data['commands']),_restart_cmds=[],_init_cmds=[],_oid_count=100,_printer=printer,_name='mcu');_finalize_config(s)
 return s._config_crc,[bytes(parser.create_command(c)).hex() for c in s._config_cmds]
crc,payloads=once();times=[]
for run in range(14):
 start=time.perf_counter()
 for i in range(100):once()
 if run>=3:times.append((time.perf_counter()-start)*1000)
print(json.dumps({'crc':crc,'payloads':payloads,'samples':sorted(times),'python':sys.version.split()[0]}))
`;
const result=spawnSync(process.env.PYTHON??'python3',['-c',python,fileURLToPath(new URL('../../klippy',import.meta.url))],{input:JSON.stringify({dictionary:definition,commands}),encoding:'utf8',timeout:60000});assert.equal(result.status,0,result.stderr);const reference=JSON.parse(result.stdout);assert.equal(crc,reference.crc);assert.deepEqual(actual,reference.payloads);
console.log(JSON.stringify({node:process.version,python:reference.python,cpu:cpus()[0].model,plans:count,commandsPerPlan:actual.length,crc,payloadsEqual:true,nodeMedianMs:times[5],nodeP95Ms:times[10],pythonMedianMs:reference.samples[5],pythonP95Ms:reference.samples[10],scope:'Node includes validation, two mocked config reads and awaited mocked ACKs; Python original config finalization and command encoder, no wire. Startup-only cost.'},null,2));
