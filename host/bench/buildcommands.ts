import {originalBuildCommands} from './build-reference.ts';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir,cpus} from 'node:os';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {inflateSync} from 'node:zlib';
import assert from 'node:assert/strict';
import {buildCommands} from '../src/build/buildcommands.ts';
const root=fileURLToPath(new URL('../../',import.meta.url));
const lines=['DECL_COMMAND_FLAGS command_identify 0 identify offset=%u count=%c','_DECL_ENCODER identify_response offset=%u data=%.*s','DECL_CONSTANT CLOCK_FREQ 72000000','DECL_CONSTANT_STR MCU "linux"','DECL_ENUMERATION_RANGE pin PA0 0 16','DECL_INITIAL_PINS "PA3,!PA7"','_DECL_STATIC_STR 运动停止'];
for(let i=0;i<200;i++)lines.push(`DECL_COMMAND_FLAGS command_${i} 0 command${i} value=%i count=%hu`,`_DECL_ENCODER response${i} value=%u data=%*s`,`_DECL_CALLLIST ctr_run_taskfuncs task_${i}`);
const fixtures=[{requests:lines.slice(0,2).join('\n'),kconfig:'CONFIG_TEST=y\n'}, {requests:lines.join('\n'),kconfig:'# 配置\r\nCONFIG_TEST=y\r\n'}];
if(process.argv[2])fixtures.push({requests:readFileSync(process.argv[2],'utf8'),kconfig:readFileSync(process.argv[3],'utf8')});
const provenance={version:'test-fixed',toolstr:'gcc: test binutils: test'};
const python=String.raw`
import sys,runpy,json,time,types
sys.path.insert(0,sys.argv[1]+'/klippy')
base=runpy.run_path(sys.argv[3])
fixtures=json.load(open(sys.argv[2]))
def run(f):
 handlers=[base[n]() for n in ['HandleCallList','HandleEnumerations','HandleConstants','HandleInitialPins','Handle_arm_irq','HandleCommandGeneration','HandleVersions','HandleKConfig','HandleIdentify']]
 g=base['HandleIdentify'].generate_code.__globals__
 g['Handlers']=handlers;g['HandlerEnumerations']=handlers[1];g['HandlerConstants']=handlers[2]
 handlers[6].version='test-fixed';handlers[6].toolstr='gcc: test binutils: test';handlers[7].defconfig=f['kconfig'].replace('\r\n','\n').replace('\r','\n')
 dispatch={k:v for h in handlers for k,v in h.ctr_dispatch.items()}
 for line in f['requests'].split('\n'):
  line=line.lstrip()
  if line:dispatch[line.split()[0]](line)
 code=base['FILEHEADER']+''.join(h.generate_code(None) for h in handlers[:6])+'\n// version: test-fixed\n// build_versions: gcc: test binutils: test\n'
 code+=handlers[8].generate_code(types.SimpleNamespace(write_dictionary=None))
 data={}
 for h in handlers:h.update_data_dictionary(data)
 return {'code':code,'dictionary':json.dumps(data,separators=(',',':'),sort_keys=True)}
results=[run(f) for f in fixtures]
for _ in range(3):run(fixtures[1])
times=[]
for _ in range(11):
 t=time.perf_counter();run(fixtures[1]);times.append((time.perf_counter()-t)*1000)
print(json.dumps({'results':results,'times':sorted(times)}))
`;
const dir=mkdtempSync(join(tmpdir(),'anyraid-buildcommands-'));
try {
 const input=join(dir,'fixtures.json');writeFileSync(input,JSON.stringify(fixtures));
 const p=spawnSync(process.env.PYTHON??'python3',['-c',python,root,input,originalBuildCommands(dir)],{encoding:'utf8',timeout:60000,maxBuffer:32*1024*1024});assert.equal(p.status,0,p.stderr||String(p.error));
 const oracle=JSON.parse(p.stdout);let compressedExact=true;const compressedSizes:{node:number;python:number}[]=[];
 for(const [i,f] of fixtures.entries()) {
  const actual=buildCommands(f.requests,f.kconfig,provenance),expected=oracle.results[i];
  assert.equal(actual.dictionary,expected.dictionary);
  const split=(code:string)=>code.split('const uint8_t command_identify_data[]');
  assert.equal(split(actual.code)[0],split(expected.code)[0].replace('scripts/buildcommands.py','scripts/buildcommands.mts'));
  const bytes=(code:string)=>Buffer.from([...split(code)[1].matchAll(/0x([0-9a-f]{2}),/g)].map(m=>parseInt(m[1],16)));
  assert.equal(inflateSync(bytes(actual.code)).toString(),actual.dictionary);
  assert.equal(inflateSync(bytes(expected.code)).toString(),actual.dictionary);
  compressedSizes.push({node:bytes(actual.code).length,python:bytes(expected.code).length});
  compressedExact &&= bytes(actual.code).equals(bytes(expected.code));
 }
 for(let i=0;i<3;i++)buildCommands(fixtures[1].requests,fixtures[1].kconfig,provenance);
 const times=[];for(let i=0;i<11;i++){const start=performance.now();buildCommands(fixtures[1].requests,fixtures[1].kconfig,provenance);times.push(performance.now()-start);}times.sort((a,b)=>a-b);
 const cliInput=join(dir,'requests.txt'),cliConfig=join(dir,'defconfig');writeFileSync(cliInput,fixtures[1].requests);writeFileSync(cliConfig,fixtures[1].kconfig);
 const baseline=originalBuildCommands(dir),cliTimes:{node:number[];python:number[]}={node:[],python:[]};
 for(let round=-3;round<11;round++)for(const kind of (round%2?['node','python']:['python','node']) as ('node'|'python')[]){
  const start=performance.now();const child=spawnSync(kind==='node'?process.execPath:process.env.PYTHON??'python3',[kind==='node'?join(root,'scripts/buildcommands.mts'):baseline,'-k',cliConfig,'-d',join(dir,kind+'.dict'),'-t','gcc;as;ld;objcopy;objdump;strip',cliInput,join(dir,kind+'.c')],{cwd:root,encoding:'utf8',timeout:30000,maxBuffer:1048576});
  assert.equal(child.status,0,child.stderr||String(child.error));if(round>=0)cliTimes[kind].push(performance.now()-start);
 }
 for(const values of Object.values(cliTimes))values.sort((a,b)=>a-b);
 const nodeDictionary=JSON.parse(readFileSync(join(dir,'node.dict'),'utf8')),pythonDictionary=JSON.parse(readFileSync(join(dir,'python.dict'),'utf8'));delete nodeDictionary.version;delete pythonDictionary.version;assert.deepEqual(nodeDictionary,pythonDictionary);
 console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,fixtures:fixtures.length,requests:lines.length,dictionaryAndTablesExact:true,compressedSizes,compressedBytesExact:compressedExact,inflateExact:true,nodeMedianMs:times[5],nodeP95Ms:times[10],pythonMedianMs:oracle.times[5],pythonP95Ms:oracle.times[10],speedup:oracle.times[5]/times[5],cliNodeMedianMs:cliTimes.node[5],cliNodeP95Ms:cliTimes.node[10],cliPythonMedianMs:cliTimes.python[5],cliPythonP95Ms:cliTimes.python[10]},null,2));
} finally {rmSync(dir,{recursive:true,force:true});}
