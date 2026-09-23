import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {PlannedMotionSource} from '../src/motion/planned-motion-source.ts';
import {Move,LookAheadQueue,motionLimits} from '../src/motion/lookahead.ts';
import {markMoveEnd} from '../src/motion/boundary-markers.ts';
import {idleMotionFixture} from '../test/helpers/idle-motion.ts';
const dir=mkdtempSync(join(tmpdir(),'source-drain-'));
try{
 const text=execFileSync('git',['show','484d4544:host/src/motion/planned-motion-source.ts'],{encoding:'utf8'}).replace(/from '([^']+)'/g,(_m,p:string)=>`from '${new URL(p,new URL('../src/motion/planned-motion-source.ts',import.meta.url)).href}'`),path=join(dir,'source.ts');writeFileSync(path,text);
 const {PlannedMotionSource:Before}=await import(pathToFileURL(path).href) as {PlannedMotionSource:typeof PlannedMotionSource};
 const sources=[Before,PlannedMotionSource].map(Base=>class extends Base{constructor(...args:ConstructorParameters<typeof PlannedMotionSource>){super(args[0],args[1],args[2],args[3],256);}});
 const samples:number[][]=[[],[]];let reference:Record<string,[bigint,bigint][]>|undefined;
 for(let run=0;run<14;run++)for(const variant of run%2?[1,0]:[0,1]){
  const f=idleMotionFixture(false,sources[variant]),queue=new LookAheadQueue(),limits=motionLimits(100,1000);
  try{
   for(let i=0;i<10000;i++){const m=new Move(limits,[50+i*.001,0,0,2],[50+(i+1)*.001,0,0,2],10);if(i%100===99)markMoveEnd(m,i+1);queue.add(m);}
   const moves=queue.flush(),signal=new AbortController().signal,start=performance.now();f.source.startAt(1);await f.source.drain(moves,signal);const elapsed=performance.now()-start;
   assert.equal(f.stops,0);assert.equal(f.positions.x,1100n);if(reference)assert.deepEqual(f.ticks,reference);else reference=structuredClone(f.ticks);if(run>=3)samples[variant].push(elapsed);
  }finally{f.close();}
 }
 const stats=samples.map(v=>{v.sort((a,b)=>a-b);return {medianMs:v[5],p95Ms:v[10]};});console.log(JSON.stringify({node:process.version,moves:10000,capacity:256,markers:100,samples:11,variants:['previousShallowSuffix','currentOwnedSuffix'],stats,exactTicks:true,scope:'Oversized drain snapshot and native generation to memory sink, no transport or physical execution.'}));
 assert(stats[1].medianMs<=stats[0].medianMs*1.3+2,'Owned drain exceeds baseline regression budget');
}finally{rmSync(dir,{recursive:true,force:true});}
