import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {ServerInformation,ServerConfiguration,type InformationSnapshot,type ConfigurationSnapshot} from '../src/moonraker/metadata.ts';
const root=process.env.MOONRAKER_SOURCE;if(!root)throw new Error('Set MOONRAKER_SOURCE');const pin=JSON.parse(readFileSync(new URL('../contracts/moonraker-upstream.json',import.meta.url),'utf8')).commit;
const information:InformationSnapshot[]=['disconnected','startup','ready','error','shutdown'].map((state,i)=>({connected:i!==0,state:state as InformationSnapshot['state'],components:['application','jsonrpc','websockets','file_manager'],failedComponents:i===3?['mqtt']:[],directories:i===0?[]:['gcodes','config'],warnings:i===0?['Migration incomplete\nNo printer']:['Warning\nsecond line','Other warning'],version:`anyraid-node-fixture-${i}`,missingRequirements:i===1?['virtual_sdcard']:[]}));
const configs:ConfigurationSnapshot[]=[{primaryFile:'/tmp/config/moonraker.conf',parsed:{server:{port:7125,host:'127.0.0.1'},settings:{enabled:true,values:[1,2,3]}},original:{server:{port:'7125',host:'127.0.0.1'},settings:{enabled:'true',values:'1,2,3'}},files:[{filename:'/tmp/config/moonraker.conf',sections:['server']},{filename:'/tmp/config/includes/settings.conf',sections:['settings']},{filename:'/tmp/config-other/external.conf',sections:['external']}]},{primaryFile:'/tmp/moonraker.conf',parsed:{},original:{},files:[]}];
const sources=information.map(s=>new ServerInformation(s)),views=configs.map(c=>new ServerConfiguration(c));
const expected=[];for(const source of sources)for(const raw of [false,true])for(const count of [0,1,50])expected.push(source.read(raw,count));
const python=String.raw`
import ast,sys,json,asyncio,types,pathlib,time,subprocess
source=subprocess.check_output(['git','-C',sys.argv[1],'show',sys.argv[2]+':moonraker/server.py'],text=True);data=json.load(sys.stdin);API_VERSION=ast.literal_eval(next(n.value for n in ast.parse(source).body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='API_VERSION' for t in n.targets)))
jsonw=types.ModuleType('json_wrapper');exec(subprocess.check_output(['git','-C',sys.argv[1],'show',sys.argv[2]+':moonraker/utils/json_wrapper.py'],text=True),jsonw.__dict__)
node=next(n for n in ast.parse(source).body if isinstance(n,ast.ClassDef) and n.name=='Server');methods=[ast.get_source_segment(source,n) for n in node.body if isinstance(n,ast.AsyncFunctionDef) and n.name in ['_handle_info_request','_handle_config_request']]
import textwrap
exec('from __future__ import annotations\nclass Server:\n'+textwrap.indent('\n'.join(methods),'    '),globals())
def server(info):
 s=Server();s.klippy_connection=types.SimpleNamespace(is_connected=lambda:info['connected'],state=info['state'],missing_requirements=info['missingRequirements']);s.components=dict.fromkeys(info['components']);s.failed_components=info['failedComponents'];s.warnings=dict(enumerate(info['warnings']));s.lookup_component=lambda name,default:types.SimpleNamespace(get_registered_dirs=lambda:info['directories']);s.websocket_manager=types.SimpleNamespace(get_count=lambda:s.count);s.app_args={'software_version':info['version']};s.count=0;return s
servers=[server(i) for i in data['information']]
views=[]
for c in data['configs']:
 s=Server();s.app_args={'config_file':c['primaryFile']};s.config=types.SimpleNamespace(get_file_sections=lambda c=c:dict((f['filename'],f['sections']) for f in c['files']),get_parsed_config=lambda c=c:dict(c['parsed']),get_orig_config=lambda c=c:c['original']);views.append(s)
requests=[types.SimpleNamespace(get_boolean=lambda key,default,raw=raw:raw) for raw in [False,True]]
async def main():
 results=[]
 for s in servers:
  for request in requests:
   for count in [0,1,50]:s.count=count;results.append(await s._handle_info_request(request))
 configurations=[await v._handle_config_request(None) for v in views];samples={'info':[],'config':[]}
 for repeat in range(14):
  t=time.perf_counter()
  for i in range(10000):jsonw.dumps(await servers[i%len(servers)]._handle_info_request(requests[i%2]))
  if repeat>=3:samples['info'].append((time.perf_counter()-t)*1000)
  t=time.perf_counter()
  for i in range(1000):jsonw.dumps(await views[i%len(views)]._handle_config_request(None))
  if repeat>=3:samples['config'].append((time.perf_counter()-t)*1000)
 print(json.dumps({'information':results,'configs':configurations,'samples':{k:sorted(v) for k,v in samples.items()},'python':sys.version.split()[0],'msgspec':jsonw.MSGSPEC_ENABLED}))
asyncio.run(main())
`;
const run=spawnSync(process.env.PYTHON??'/usr/bin/python3',['-c',python,root,pin],{input:JSON.stringify({information,configs}),encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});assert.equal(run.status,0,run.stderr||String(run.error));const reference=JSON.parse(run.stdout);assert.deepEqual(expected,reference.information);assert.deepEqual(views.map(v=>v.read()),reference.configs);
const samples={info:[] as number[],config:[] as number[]};for(let run=0;run<14;run++){let start=performance.now();for(let i=0;i<10000;i++)JSON.stringify(sources[i%sources.length].read(i%2===1,50));if(run>=3)samples.info.push(performance.now()-start);start=performance.now();for(let i=0;i<1000;i++)JSON.stringify(views[i%views.length].read());if(run>=3)samples.config.push(performance.now()-start);}for(const v of Object.values(samples))v.sort((a,b)=>a-b);
console.log(JSON.stringify({upstream:pin,node:process.version,python:reference.python,msgspec:reference.msgspec,infoFixtures:expected.length,configFixtures:views.length,infoRequests:10000,configRequests:1000,nodeInfoMedianMs:samples.info[5],nodeInfoP95Ms:samples.info[10],pythonInfoMedianMs:reference.samples.info[5],pythonInfoP95Ms:reference.samples.info[10],nodeConfigMedianMs:samples.config[5],nodeConfigP95Ms:samples.config[10],pythonConfigMedianMs:reference.samples.config[5],pythonConfigP95Ms:reference.samples.config[10],scope:'Pinned Server info/config handlers with inert runtime/config sources; Upstream JSON wrapper response encoding included. Node precomputes immutable config paths on replacement; Python resolves primary config path on reads. No loader, restart or printing-load claim.'},null,2));
