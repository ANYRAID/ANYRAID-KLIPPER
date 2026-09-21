import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {KlipperSaveSession} from '../src/config/klipper-save-session.ts';
import {loadKlipperConfiguration} from '../src/config/klipper-files.ts';
const dir=await mkdtemp(join(tmpdir(),'save-session-bench-')),path=join(dir,'printer.cfg'),current='[x]\na: original\n',times:number[]=[];
try{
 await writeFile(path,current);const session=new KlipperSaveSession(path,current);let previous=current;
 for(let i=0;i<16;i++){
  session.apply([{kind:'set',section:'x',option:'a',value:String(i)}]);
  const start=performance.now(),result=await session.save(),elapsed=performance.now()-start;
  assert.ok(result);assert.equal(result.pending,false);assert.equal(result.restartRequired,true);assert.equal(session.status.state,'saved');assert.equal(await readFile(result.backupPath,'utf8'),previous);previous=await readFile(path,'utf8');assert.equal((await loadKlipperConfiguration(path)).original.x.a,String(i));if(i>=5)times.push(elapsed);
 }
 times.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,saves:16,warmup:5,medianMs:times[5],p95Ms:times[10],scope:'Real temporary files, prepare plus durable commit plus snapshot acknowledgement. Each saved value and exact previous backup verified outside timing. No device restart or hardware acceptance; no equal-work Python comparison.'},null,2));
}finally{await rm(dir,{recursive:true,force:true});}
