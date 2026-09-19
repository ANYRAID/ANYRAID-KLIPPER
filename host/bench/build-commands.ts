import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir,cpus} from 'node:os';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {BuildCommands, signedMessageId} from '../src/build/commands.ts';
const base=['DECL_COMMAND_FLAGS command_identify 0 identify offset=%u count=%c','_DECL_ENCODER identify_response offset=%u data=%.*s'];
const lines=[...base];
for(let i=0;i<1000;i++)lines.push(`DECL_COMMAND_FLAGS command_${i} 0 command${i} u=%u i=%i hu=%hu hi=%hi byte=%c str=%s buf=%*s prog=%.*s`,`_DECL_ENCODER response${i} u=%u byte=%c`);
lines.push('_DECL_OUTPUT log %u %i %hu %hi %c %s %*s %.*s','_DECL_OUTPUT log %u %i %hu %hi %c %s %*s %.*s');
const boundary=[...base];for(let i=0;i<12300;i++)boundary.push(`_DECL_ENCODER r${i} v=%u`);
const fixtures=[base,lines,boundary];
const python=String.raw`
import ast,sys,json,time
sys.path.insert(0,sys.argv[2]);import msgproto
text=open(sys.argv[1]).read();STATIC_STRING_MIN=2
def error(msg):raise ValueError(msg)
for name in ['HandleCommandGeneration']:
 node=next(n for n in ast.parse(text).body if isinstance(n,ast.ClassDef) and n.name==name);exec(ast.get_source_segment(text,node),globals())
data=json.load(open(sys.argv[3]))
def run(lines):
 handlers=[HandleCommandGeneration()]
 dispatch={k:v for h in handlers for k,v in h.ctr_dispatch.items()}
 for line in lines:dispatch[line.split()[0]](line)
 code=''.join(h.generate_code(None) for h in handlers);dictionary={}
 for h in handlers:h.update_data_dictionary(dictionary)
 return {'code':code,'dictionary':dictionary}
results=[run(lines) for lines in data]
for _ in range(3):run(data[1])
times=[]
for _ in range(11):
 start=time.perf_counter();run(data[1]);times.append((time.perf_counter()-start)*1000)
print(json.dumps({'results':results,'times':sorted(times),'ids':[HandleCommandGeneration().convert_encoded_msgid(i) for i in range(16384)]}))
`;
const dir=mkdtempSync(join(tmpdir(),'anyraid-build-commands-'));let oracle:{results:{code:string;dictionary:unknown}[];times:number[];ids:number[]};
function run(lines:string[]){const b=new BuildCommands();for(const line of lines)if(!b.accept(line))throw new Error('Unhandled metadata');return {code:b.generate(),dictionary:b.dictionary()};}
try {
 const input=join(dir,'input.json');writeFileSync(input,JSON.stringify(fixtures));
 const p=spawnSync(process.env.PYTHON??'python3',['-c',python,fileURLToPath(new URL('../../scripts/buildcommands.py',import.meta.url)),fileURLToPath(new URL('../../klippy',import.meta.url)),input],{encoding:'utf8',timeout:60000,maxBuffer:32*1024*1024});if(p.status!==0)throw new Error(p.stderr||String(p.error));oracle=JSON.parse(p.stdout);
 assert.deepEqual(Array.from({length:16384},(_,i)=>signedMessageId(i)),oracle.ids);
 fixtures.forEach((f,i)=>assert.deepEqual(run(f),oracle.results[i]));
 const source=join(dir,'generated.c');writeFileSync(source,`#include <stdint.h>
#include <stddef.h>
#undef __always_inline
#define __always_inline __attribute__((always_inline))
#define PROGMEM
#define ARRAY_SIZE(x) (sizeof(x)/sizeof(x[0]))
enum {PT_uint32,PT_int32,PT_uint16,PT_int16,PT_byte,PT_string,PT_buffer,PT_progmem_buffer};
struct command_encoder {uint16_t encoded_msgid; uint8_t num_params; const uint8_t *param_types; uint8_t max_size,min_size;};
struct command_parser {uint16_t encoded_msgid; uint8_t num_params; const uint8_t *param_types; uint8_t num_args,flags; void (*func)(uint32_t*);};
`+run(lines).code);
 const cc=spawnSync(process.env.CC??'cc',['-std=gnu11','-Werror','-fsyntax-only',source],{encoding:'utf8',timeout:30000});assert.equal(cc.status,0,cc.stderr);
}finally{rmSync(dir,{recursive:true,force:true});}
for(let i=0;i<3;i++)run(lines);const times=[];for(let i=0;i<11;i++){const start=performance.now();run(lines);times.push(performance.now()-start);}times.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,requests:lines.length,fixtures:fixtures.length,codeAndDictionaryExact:true,cSyntaxPassed:true,nodeMedianMs:times[5],nodeP95Ms:times[10],pythonMedianMs:oracle.times[5],pythonP95Ms:oracle.times[10],speedup:oracle.times[5]/times[5]},null,2));
