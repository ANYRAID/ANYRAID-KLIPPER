import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir,cpus} from 'node:os';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../../',import.meta.url)),dir=mkdtempSync(join(tmpdir(),'anyraid-firmware-bench-'));
const timings=[];
try {
 for(const kind of ['mks_robin','chitu']) {
  const source=execFileSync('git',['-C',root,'show',`ce7002be:scripts/update_${kind}.py`],{encoding:'utf8'}),legacy=join(dir,kind+'.py');writeFileSync(legacy,source);
  const input=join(dir,'input name.bin'),oldOutput=join(dir,'python.bin'),newOutput=join(dir,'node.bin');
  const run=(python:boolean)=>{const p=spawnSync(python?(process.env.PYTHON??'python3'):process.execPath,[python?legacy:root+`scripts/update_${kind}.mts`,input,python?oldOutput:newOutput],{encoding:'utf8',timeout:30000});if(p.status!==0)throw new Error(JSON.stringify({kind,python,status:p.status,signal:p.signal,error:String(p.error),stderr:p.stderr}));return p.stdout;};
  for(const size of [0,1,2,3,319,320,321,2047,2048,2049,31039,31040,31041,65536,1048576]) {
   const data=Buffer.alloc(size);for(let i=0;i<size;i++)data[i]=(i*73+(i>>>8)*31)&255;writeFileSync(input,data);
   assert.equal(run(false),run(true));assert.deepEqual(readFileSync(newOutput),readFileSync(oldOutput),kind+' size '+size);
  }
  for(let i=0;i<3;i++){run(false);run(true);}const node:number[]=[],python:number[]=[];
  for(let i=0;i<11;i++){let start=performance.now();run(false);node.push(performance.now()-start);start=performance.now();run(true);python.push(performance.now()-start);}
  node.sort((a,b)=>a-b);python.sort((a,b)=>a-b);timings.push({kind,size:1048576,nodeMedianMs:node[5],nodeP95Ms:node[10],pythonMedianMs:python[5],pythonP95Ms:python[10],speedup:python[5]/node[5]});
 }
 const bridge=String.raw`
import ast,os,sys,types,subprocess
text=open(os.path.join(sys.argv[1],'scripts/spi_flash/spi_flash.py')).read()
node=next(n for n in ast.parse(text).body if isinstance(n,ast.FunctionDef) and n.name=='check_need_convert')
fatfs_lib=types.SimpleNamespace(KLIPPER_DIR=sys.argv[1]);output=output_line=lambda s:None
exec(ast.get_source_segment(text,node),globals())
os.environ['NODE']=sys.argv[3]
config={'conversion_script':'scripts/update_mks_robin.mts','klipper_bin_path':os.path.join(sys.argv[2],'input name.bin'),'firmware_path':'folder/Robin image.bin'}
check_need_convert('test',config)
assert config['klipper_bin_path']==os.path.join(sys.argv[2],'Robin image.bin')
assert os.path.isfile(config['klipper_bin_path'])
config['klipper_bin_path']=os.path.join(sys.argv[2],'missing input.bin')
try:check_need_convert('test',config)
except subprocess.CalledProcessError:pass
else:raise AssertionError('Conversion failure was ignored')
assert config['klipper_bin_path'].endswith('missing input.bin')
`;
 const bridgeResult=spawnSync(process.env.PYTHON??'python3',['-c',bridge,root,dir,process.execPath],{encoding:'utf8',timeout:30000});
 assert.equal(bridgeResult.status,0,bridgeResult.stderr||String(bridgeResult.error));
}finally{rmSync(dir,{recursive:true,force:true});}
console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,fixtures:30,bytesAndStdoutExact:true,legacyUploadConversionBridge:true,timings},null,2));
