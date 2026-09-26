import {execFileSync} from 'node:child_process';
import {writeFile,rm} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {Move,motionLimits} from '../src/motion/lookahead.ts';
import {TrapQueue} from '../src/motion/trap-queue.ts';
const baseline=execFileSync('git',['show','2246d604:host/src/motion/trap-queue.ts'],{encoding:'utf8'}),path=new URL(`../src/motion/.trapq-baseline-${randomUUID()}.ts`,import.meta.url);
const moves=Array.from({length:10000},(_,i)=>{const m=new Move(motionLimits(100,1000),[i,0,0,0],[i+1,0,0,0],5);m.setJunction(0,25,0);return m;});
try{
 await writeFile(path,baseline,{flag:'wx'});const {TrapQueue:Previous}=await import(path.href);
 const samples:{baseline:number[];current:number[]}={baseline:[],current:[]};let reference:string|undefined;
 for(let i=0;i<30;i++)for(const name of (i%2?['current','baseline']:['baseline','current']) as ('baseline'|'current')[]){
  using queue=name==='baseline'?new Previous():new TrapQueue();const start=performance.now(),end=queue.appendPlanned(moves,1),elapsed=performance.now()-start;
  const data=queue.extract(40000,0,end+1),digest=createHash('sha256').update(Buffer.from(data.buffer,data.byteOffset,data.byteLength)).digest('hex');reference??=digest;assert.equal(digest,reference);if(i>=5)samples[name].push(elapsed);
 }
 const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[12],p95Ms:values[23]};},old=stats(samples.baseline),current=stats(samples.current);
 console.log(JSON.stringify({node:process.version,moves:moves.length,warmups:5,runs:25,baselineCommit:'2246d604',baselineSha256:createHash('sha256').update(baseline).digest('hex'),baseline:old,current,exactNativeRowsSha256:reference,scope:'Alternating appendPlanned of 10000 ordinary moves into actual native queue. Queue allocation, extraction and hashing excluded. No physical printer throughput claim.'},null,2));
 assert(current.medianMs<=old.medianMs*1.15+1);assert(current.p95Ms<=old.p95Ms*1.25+2);
}finally{await rm(fileURLToPath(path),{force:true});}
