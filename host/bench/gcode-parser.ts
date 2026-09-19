import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir,cpus} from 'node:os';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {parseCommand,rawParameters,extendedParameters} from '../src/gcode/parser.ts';
const lines:string[]=[];
for(let i=0;i<4000;i++)lines.push(`N${i} G1X${i*.01}Y-${i%53}.125E.02F6000*42`,
 `SET_TEST NAME="Part ${i}; # Case" VALUE='a b' PATH=a\\ b K=x=y # comment`,
 'G1 X2X3 E-.01 ; tail','M117 Ready now','SET_TEST EMPTY="" V="a\\qb"');
lines.push('', '; ignored','N5 SET_TEST NAME="a b"*42','SET_TEST MISSING','SET_TEST V="unterminated','SET_TEST X=x\\',
 'SET_TEST __proto__=value =empty','G1X1e-3','N0 G1 X1 *123','SET_TEST A="x\\"y"');
const python=String.raw`
import sys,json,time,importlib.util
spec=importlib.util.spec_from_file_location('gcode',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
lines=json.load(open(sys.argv[2]))
g=m.GCodeDispatch.__new__(m.GCodeDispatch);g.gcode_handlers={};g.respond_info=lambda *a:None;g.respond_raw=lambda *a:None
out=[]
def handler(c):
 raw=c.get_raw_command_parameters();error=False
 if c.get_command()=='SET_TEST':
  try:g._get_extended_params(c)
  except m.CommandError:error=True
 out.append([c.get_command(),c.get_commandline(),None if error else c.get_command_parameters(),raw,error])
g.cmd_default=handler
for line in lines:g._process_commands([line],need_ack=False)
result=list(out)
for _ in range(3):out.clear();g._process_commands(lines,need_ack=False)
times=[]
for _ in range(11):
 out.clear();start=time.perf_counter();g._process_commands(lines,need_ack=False);times.append((time.perf_counter()-start)*1000)
print(json.dumps({'result':result,'times':sorted(times)}))
`;
const dir=mkdtempSync(join(tmpdir(),'anyraid-parser-'));let oracle;
try {
 const input=join(dir,'input.json');writeFileSync(input,JSON.stringify(lines));
 const p=spawnSync(process.env.PYTHON??'python3',['-c',python,fileURLToPath(new URL('../../klippy/gcode.py',import.meta.url)),input],{encoding:'utf8',timeout:60000,maxBuffer:32*1024*1024});
 if(p.status!==0)throw new Error(p.stderr||String(p.error));oracle=JSON.parse(p.stdout);
}finally{rmSync(dir,{recursive:true,force:true});}
function run() {
 return lines.map(line=>{
  const p=parseCommand(line),raw=rawParameters(p);let error=false,params:Record<string,string>|null=p.params;
  if(p.command==='SET_TEST')try{params=extendedParameters(p);}catch{error=true;params=null;}
  return [p.command,p.commandline,params,raw,error];
 });
}
assert.deepEqual(JSON.parse(JSON.stringify(run())),oracle.result);
for(let i=0;i<3;i++)run();const times=[];
for(let i=0;i<11;i++){const start=performance.now();run();times.push(performance.now()-start);}times.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,lines:lines.length,exact:true,nodeMedianMs:times[5],nodeP95Ms:times[10],pythonMedianMs:oracle.times[5],pythonP95Ms:oracle.times[10],speedup:oracle.times[5]/times[5]},null,2));
assert.ok(times[5]<=oracle.times[5],'G-code parsing regressed against Python');
