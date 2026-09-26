import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ProductHostControl} from '../src/runtime/product-host-control.ts';
const dir=await mkdtemp(join(tmpdir(),'recovery-bench-')),controls=[new ProductHostControl(),new ProductHostControl()],admission:number[][]=[[],[]],completion:number[][]=[[],[]];
try{
 await controls[1].configure({path:join(dir,'recovery.db'),deviceId:'printer'});for(const control of controls)control.attach(async()=>{});
 for(let run=0;run<14;run++)for(const mode of run%2?[1,0]:[0,1]){const control=controls[mode],id=String(run);let send:((sent:boolean)=>void)|undefined;const begin=performance.now();await control.request(id,control.status.state_token,callback=>{send=callback;});const ack=performance.now()-begin;send!(true);while(control.operation(id)?.state!=='succeeded'){assert(performance.now()-begin<1000);await new Promise(resolve=>setImmediate(resolve));}const total=performance.now()-begin;if(run>=3){admission[mode].push(ack);completion[mode].push(total);}}
 const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[5],p95Ms:values[10]};},accepted=admission.map(stats),complete=completion.map(stats);
 console.log(JSON.stringify({node:process.version,warmup:3,runs:11,variants:['memory','sqliteWorker'],admission:accepted,completion:complete,scope:'Alternating recovery admission and queued/running/succeeded receipt persistence, immediate mock reinitializer, local filesystem. Excludes worker/database startup, network and MCU replacement; terminal status polled with setImmediate.'},null,2));assert(accepted[1].p95Ms<100);assert(complete[1].p95Ms<100);
}finally{for(const control of controls)await control.close();await rm(dir,{recursive:true,force:true});}
