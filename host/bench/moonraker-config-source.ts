import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,link,symlink} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {performance} from 'node:perf_hooks';
import {loadConfiguration} from '../src/moonraker/config-source.ts';
import {ServerConfiguration} from '../src/moonraker/metadata.ts';
const upstream=process.env.MOONRAKER_SOURCE;if(!upstream)throw new Error('MOONRAKER_SOURCE must point to pinned Moonraker checkout');
const pin='1cfb0c41e468645951a371621f06d32777b6107c';assert.equal(spawnSync('git',['-C',upstream,'rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim(),pin);
const sourcePath=join(upstream,'moonraker/confighelper.py');
assert.equal(spawnSync('git',['-C',upstream,'diff','HEAD','--','moonraker/confighelper.py'],{encoding:'utf8'}).stdout,'');
const directory=await mkdtemp(join(tmpdir(),'node-config-oracle-'));
const python=String.raw`
import ast,sys,json,pathlib,configparser,threading,re,os,time,platform,logging
from typing import *
from io import StringIO
request=json.load(sys.stdin)
class ConfigError(Exception): pass
module=ast.parse(pathlib.Path(request['source']).read_text())
classes=[n for n in module.body if isinstance(n,ast.ClassDef) and n.name in ('ConfigSourceWrapper','FileSourceWrapper')]
exec('from __future__ import annotations\n'+ast.unparse(ast.Module(body=classes,type_ignores=[])),globals())
def load(path):
 s=FileSourceWrapper(None)
 s.read_file(pathlib.Path(path))
 if not s.config.has_section('server'): raise ConfigError('No server')
 return {'original':s.as_dict(),'files':[{'filename':p,'sections':v} for p,v in s.get_file_sections().items()]}
results=[]
for path in request['paths']:
 try: results.append({'ok':True,**load(path)})
 except Exception: results.append({'ok':False})
samples=[]
for run in range(14):
 start=time.perf_counter()
 for i in range(request['iterations']): load(request['benchmark'])
 if run>=3:samples.append((time.perf_counter()-start)*1000)
print(json.dumps({'results':results,'samples':sorted(samples),'python':platform.python_version()}))
`;
try{
 const cases=[
  '[server]\nport:7125',
  '[DEFAULT]\nx=1\n[server]\ny=2',
  '[server]\nvalue=%(base)s {value}',
  '[server]\ntext=a\n  b\n\n# comment\n  c',
  '[server]\nx=abc # comment\ny=abc;literal\nz=a \\# keep \\; keep',
  '[server]\nX=1\nx=2',
  '[server]\nx=1\nx=2',
  '[server]\n[server]',
  '[server]\nx',
  'x=1\n[server]',
  '[other]\nx=1',
  '[server]\n[include missing*]',
  '[server]\n[include ]',
  '[server]\nx=1\n[include child.conf]\ny=2',
  '[server]\n[include child.conf]\n[other]\ny=2',
  '[server]\n[include parts/*.conf]',
  '[server]\n[include parts/**/??.conf]',
  '[server]\n[include child.conf]\n[include child.conf]',
  '[server]\n[include child.conf]\n[include hard.conf]',
  '[server]\n[include child.conf]\n[include soft.conf]',
  '[server] extra\nx=1',
  '[server]\nx=\n\tfirst\n\tsecond',
  '[server]\n__proto__=value\n[__proto__]\nconstructor=raw',
  '\ufeff[server]\nx=1',
  '[server]\nx=one\u0085y=two',
  '[DEFAULT]\nx=first\n[server]\nx=override\n[include child.conf]',
  '[server]\n[include parts/[ab]?.conf]',
  '[server]\n[include parts/{literal}]',
  '[server]\n[include parts/**]',
  '[server]\n[include main.conf]',
  '[server]\nx=1\n[include child.conf]\n[server]\nx=2',
  '[server]\nA=1\n[include upper.conf]\n[other]\nx=2',
  '[DEFAULT]\nx=1\n[DEFAULT]\ny=2',
  '[server]\nempty:\nurl:http://host/#anchor\nseparator=a:b=c',
  '[server]\ntext=a\n\t\\# note\n\t\\; note\n\tz',
  '[server]\n[include parts/../child.conf]',
  '[server]\n[include @ROOT@/child.conf]',
  '[server]\n[include @ROOT@/parts/../child.conf]',
  '[server]\n[include @ROOT@/p*/a1.conf]',
 ];
 const paths:string[]=[];
 for(let i=0;i<cases.length;i++){
  const root=join(directory,String(i));await mkdir(join(root,'parts/deep'),{recursive:true});
  for(const [name,text]of Object.entries({'main.conf':cases[i].replaceAll('@ROOT@',root),'child.conf':'[DEFAULT]\nbase=child\n[server]\nport=8000\n[child]\nx=1','upper.conf':'[server]\na=2','parts/a1.conf':'[one]\nx=1','parts/deep/b2.conf':'[two]\ny=2','parts/.h.conf':'[hidden]\nx=3','parts/{literal}':'[literal]\nx=4'}))await writeFile(join(root,name),text);
  await link(join(root,'child.conf'),join(root,'hard.conf'));await symlink('child.conf',join(root,'soft.conf'));paths.push(join(root,'main.conf'));
 }
 const benchRoot=join(directory,'benchmark');await mkdir(benchRoot);await writeFile(join(benchRoot,'main.conf'),'[DEFAULT]\nshared=default\n[server]\nport=7125\n[include part*.conf]');
 for(let i=0;i<8;i++)await writeFile(join(benchRoot,`part${i}.conf`),Array.from({length:8},(_,s)=>`[component_${i}_${s}]\n`+Array.from({length:12},(_,v)=>`value${v}=example ${v}\n`).join('')).join(''));
 const benchmark=join(benchRoot,'main.conf'),iterations=30;
 const reference=spawnSync(process.env.PYTHON??'/usr/bin/python3',['-c',python],{input:JSON.stringify({source:sourcePath,paths,benchmark,iterations}),encoding:'utf8',maxBuffer:8*1024*1024});if(reference.status!==0)throw new Error(reference.stderr);
 const result=JSON.parse(reference.stdout);
 for(let i=0;i<paths.length;i++){let actual;try{const value=await loadConfiguration(paths[i]);actual={ok:true,original:value.original,files:value.files};}catch{actual={ok:false};}assert.deepEqual(JSON.parse(JSON.stringify(actual)),result.results[i],`fixture ${i}: ${cases[i]}`);}
 const samples:number[]=[];for(let run=0;run<14;run++){const start=performance.now();for(let i=0;i<iterations;i++)await loadConfiguration(benchmark);if(run>=3)samples.push(performance.now()-start);}samples.sort((a,b)=>a-b);
 const loaded=await loadConfiguration(benchmark),view=new ServerConfiguration(loaded.snapshot({server:{port:7125}})),reads:number[]=[];
 // Remove actual files to prove the request read path performs no filesystem IO.
 await rm(benchRoot,{recursive:true,force:true});for(let run=0;run<14;run++){const start=performance.now();for(let i=0;i<1000;i++)JSON.stringify(view.read());if(run>=3)reads.push(performance.now()-start);}reads.sort((a,b)=>a-b);
 console.log(JSON.stringify({upstream:pin,node:process.version,python:result.python,fixtures:paths.length,filesPerLoad:9,sectionsPerLoad:65,optionsPerLoad:770,iterations,nodeLoadMedianMs:samples[5],nodeLoadP95Ms:samples[10],pythonLoadMedianMs:result.samples[5],pythonLoadP95Ms:result.samples[10],cachedReadRequests:1000,cachedReadMedianMs:reads[5],cachedReadP95Ms:reads[10],scope:'Warm-cache real file loading; original pinned FileSourceWrapper from AST, no patched parsing. Python samples precede Node samples; async Node I/O versus synchronous Python. No disk-cold or concurrent printing claim. Cached JSON response reads after deleting source files.'},null,2));
}finally{await rm(directory,{recursive:true,force:true});}
