import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {KlipperSaveSession} from '../src/config/klipper-save-session.ts';
import {registerSaveConfig} from '../src/config/klipper-save-command.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
import {loadKlipperConfiguration} from '../src/config/klipper-files.ts';
const dir=await mkdtemp(join(tmpdir(),'save-command-bench-')),path=join(dir,'printer.cfg'),times:number[]=[];let current='[x]\na: old\n',restarts=0;
try{await writeFile(path,current);
 for(let i=0;i<16;i++){
  const s=new KlipperSaveSession(path,current),d=new GCodeDispatch({output(){},shutdown(){throw new Error('unexpected shutdown');}});d.setReady(true);s.apply([{kind:'set',section:'x',option:'a',value:String(i)}]);registerSaveConfig(d,s,()=>{restarts++;});
  const start=performance.now();await d.execute('SAVE_CONFIG');const elapsed=performance.now()-start;
  assert.equal(s.status.sealedForRestart,true);assert.equal(s.status.save_config_pending,false);assert.equal(restarts,i+1);assert.equal((await loadKlipperConfiguration(path)).original.x.a,String(i));current=await readFile(path,'utf8');if(i>=5)times.push(elapsed);
 }
 times.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,commands:16,warmup:5,medianMs:times[5],p95Ms:times[10],scope:'Actual dispatch, prepare, durable file save and restart-request stub. Session setup and readback excluded. No physical restart, activation or equal-work Python timing claim.'},null,2));
}finally{await rm(dir,{recursive:true,force:true});}
