import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir,cpus} from 'node:os';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {BuildMetadata} from '../src/build/metadata.ts';
const lines=['DECL_CONSTANT CLOCK_FREQ 72000000','DECL_CONSTANT_STR MCU "stm32f103xe"','DECL_ENUMERATION_RANGE pin PA0 0 16','DECL_ENUMERATION_RANGE pin PB0 16 16','DECL_INITIAL_PINS "PA3,!PB7"','DECL_ARMCM_IRQ ResetHandler -15','DECL_ARMCM_IRQ SysTickHandler -1','DECL_ARMCM_IRQ TimerHandler 28'];
for(let i=0;i<80;i++)lines.push('_DECL_STATIC_STR status '+i);
for(let i=0;i<200;i++)lines.push(`DECL_CONSTANT CONST_${i} ${i}`,`DECL_ENUMERATION bus BUS${i} ${i}`);
for(let i=0;i<4000;i++)lines.push(`_DECL_CALLLIST ${i%2?'ctr_run_taskfuncs':'ctr_run_initfuncs'} func_${i}`);
const fixtures=[[],lines.slice(0,5),lines];
const python=String.raw`
import ast,sys,json,time
sys.path.insert(0,sys.argv[2]);import msgproto
text=open(sys.argv[1]).read();STATIC_STRING_MIN=2
def error(msg):raise ValueError(msg)
for name in ['HandleCallList','HandleEnumerations','HandleConstants','HandleInitialPins','Handle_arm_irq']:
 node=next(n for n in ast.parse(text).body if isinstance(n,ast.ClassDef) and n.name==name);exec(ast.get_source_segment(text,node),globals())
data=json.load(open(sys.argv[3]))
def run(lines):
 global HandlerEnumerations,HandlerConstants
 HandlerEnumerations=HandleEnumerations();HandlerConstants=HandleConstants();handlers=[HandleCallList(),HandlerEnumerations,HandlerConstants,HandleInitialPins(),Handle_arm_irq()]
 dispatch={k:v for h in handlers for k,v in h.ctr_dispatch.items()}
 for line in lines:dispatch[line.split()[0]](line)
 code=''.join(h.generate_code(None) for h in handlers);dictionary={}
 for h in handlers:h.update_data_dictionary(dictionary)
 return {'code':code,'dictionary':dictionary}
results=[run(lines) for lines in data]
for _ in range(3):run(data[-1])
times=[]
for _ in range(11):
 start=time.perf_counter();run(data[-1]);times.append((time.perf_counter()-start)*1000)
print(json.dumps({'results':results,'times':sorted(times)}))
`;
const dir=mkdtempSync(join(tmpdir(),'anyraid-build-metadata-'));let oracle:{results:{code:string;dictionary:unknown}[];times:number[]};
function run(lines:string[]){const b=new BuildMetadata();for(const line of lines)if(!b.accept(line))throw new Error('Unhandled metadata');return {code:b.generate(),dictionary:b.dictionary()};}
try {
 const input=join(dir,'input.json');writeFileSync(input,JSON.stringify(fixtures));
 const p=spawnSync(process.env.PYTHON??'python3',['-c',python,fileURLToPath(new URL('../../scripts/buildcommands.py',import.meta.url)),fileURLToPath(new URL('../../klippy',import.meta.url)),input],{encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024});if(p.status!==0)throw new Error(p.stderr||String(p.error));oracle=JSON.parse(p.stdout);
 fixtures.forEach((f,i)=>assert.deepEqual(run(f),oracle.results[i]));
 const source=join(dir,'generated.c');writeFileSync(source,'#include <stdint.h>\n#undef __always_inline\n#define __always_inline __attribute__((always_inline))\n#define PROGMEM\n#define __visible\n#define __section(x)\n#define ARRAY_SIZE(x) (sizeof(x)/sizeof(x[0]))\n#define IP_OUT_HIGH 1\nstruct initial_pin_s {int pin; int flags;};\nvoid irq_poll(void);\n'+run(lines).code);
 const cc=spawnSync(process.env.CC??'cc',['-std=gnu11','-Werror','-fsyntax-only',source],{encoding:'utf8',timeout:30000});assert.equal(cc.status,0,cc.stderr);
}finally{rmSync(dir,{recursive:true,force:true});}
for(let i=0;i<3;i++)run(lines);const times=[];for(let i=0;i<11;i++){const start=performance.now();run(lines);times.push(performance.now()-start);}times.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,requests:lines.length,fixtures:fixtures.length,codeAndDictionaryExact:true,cSyntaxPassed:true,nodeMedianMs:times[5],nodeP95Ms:times[10],pythonMedianMs:oracle.times[5],pythonP95Ms:oracle.times[10],speedup:oracle.times[5]/times[5]},null,2));
