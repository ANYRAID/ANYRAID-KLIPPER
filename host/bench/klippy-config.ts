import assert from 'node:assert/strict';
import {mkdtemp,mkdir,symlink,rm} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {resolveKlippyPath} from '../src/moonraker/klippy-config.ts';
const source=process.env.MOONRAKER_SOURCE;if(!source)throw new Error('Set MOONRAKER_SOURCE');const pin=JSON.parse(readFileSync(new URL('../contracts/moonraker-upstream.json',import.meta.url),'utf8')).commit;
const root=await mkdtemp(join(tmpdir(),'kpc-'));
try{await mkdir(join(root,'real','nested'),{recursive:true});await symlink(join(root,'real','nested'),join(root,'link'));await symlink('absent/nested',join(root,'dangling'));
 const fixtures=['/tmp/klippy_uds','socket','link/../api.sock','dangling/../api.sock','~/api.sock','\x1c/tmp/klippy_uds\x1c','\ufeffsocket'];
 const python=String.raw`
import pathlib,os,sys,json,ast,subprocess,time
source=subprocess.check_output(['git','-C',sys.argv[1],'show',sys.argv[2]+':moonraker/components/klippy_connection.py'],text=True)
call=next(n for n in ast.walk(ast.parse(source)) if isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute) and n.func.attr=='getpath' and n.args and isinstance(n.args[0],ast.Constant) and n.args[0].value=='klippy_uds_address')
default=call.args[1].args[0].value
os.chdir(sys.argv[3]);os.environ['HOME']=sys.argv[3]
fixtures=json.load(sys.stdin);results=[str(pathlib.Path(p.strip()).expanduser().resolve()) for p in fixtures];samples=[]
for run in range(54):
 start=time.perf_counter()
 for i in range(100):pathlib.Path('link/../api.sock').resolve()
 if run>=3:samples.append((time.perf_counter()-start)*1000)
print(json.dumps({'default':default,'results':results,'samples':samples,'python':sys.version.split()[0]}))
`;
 const result=spawnSync('/usr/bin/python3',['-c',python,source,pin,root],{input:JSON.stringify(fixtures),encoding:'utf8'});assert.equal(result.status,0,result.stderr);const oracle=JSON.parse(result.stdout);assert.equal(oracle.default,'/tmp/klippy_uds');assert.deepEqual(await Promise.all(fixtures.map(f=>resolveKlippyPath(f,{cwd:root,home:root}))),oracle.results);
 const samples:number[]=[];for(let run=0;run<54;run++){const start=performance.now();for(let i=0;i<100;i++)assert.equal(await resolveKlippyPath('link/../api.sock',{cwd:root}),join(root,'real','api.sock'));if(run>=3)samples.push(performance.now()-start);}
 const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[25],p95Ms:values[48]};};console.log(JSON.stringify({node:process.version,python:oracle.python,contracts:fixtures.length,upstream:pin,samples:51,resolutionsPerSample:100,nodePath:stats(samples),pythonPath:stats(oracle.samples),scope:'Filesystem startup path resolution only, including symlink-before-dot-dot and dangling links; Python pathlib oracle plus pinned default. No Jinja or printing throughput equivalence claim.'},null,2));
}finally{await rm(root,{recursive:true,force:true});}
