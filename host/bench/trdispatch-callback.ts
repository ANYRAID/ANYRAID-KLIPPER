import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../../',import.meta.url)),helper=join(root,'klippy/chelper'),dir=mkdtempSync(join(tmpdir(),'trdispatch-bench-'));
function run(command:string,args:string[]){const p=spawnSync(command,args,{cwd:root,encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});if(p.status!==0)throw new Error(p.stderr||String(p.error));return p.stdout;}
try{
 // Last committed original algorithm before the monotonic-renewal fix.
 const old=join(dir,'before.c');writeFileSync(old,run('git',['show','4a429675:klippy/chelper/trdispatch.c']));
 const sources=[old,join(helper,'trdispatch.c')],binaries=sources.map((source,i)=>{
  const out=join(dir,`callback-${i}`);run(process.env.CC??'cc',['-O2',`-I${helper}`,`-DTRDISPATCH_SOURCE=${JSON.stringify(source)}`,join(root,'host/bench/fixtures/trdispatch-benchmark.c'),join(helper,'msgblock.c'),join(helper,'pyhelper.c'),'-lm','-pthread','-o',out]);return out;
 });
 for(const mcus of [1,2,8,16]){
  const samples:number[][]=[[],[]];let expected:{sent:number;hash:string}|undefined;
  for(let round=0;round<14;round++)for(const index of (round%2?[1,0]:[0,1])){
   const result=JSON.parse(run(binaries[index],[String(mcus)])) as {ms:number;sent:number;hash:string};
   const output={sent:result.sent,hash:result.hash};if(!expected)expected=output;else assert.deepEqual(output,expected,'Normal report output changed');
   if(round>=3)samples[index].push(result.ms);
  }
  for(const times of samples)times.sort((a,b)=>a-b);
  console.log(JSON.stringify({mcus,reports:100000,originalMedianMs:samples[0][5],originalP95Ms:samples[0][10],fixedMedianMs:samples[1][5],fixedP95Ms:samples[1][10],outputs:expected,scope:'C callback with checksum queue sink; excludes serial I/O, Node and hardware scheduling'}));
  assert.ok(samples[1][5]<=samples[0][5]*1.2,'Native callback median regressed more than 20%');
 }
}finally{rmSync(dir,{recursive:true,force:true});}
