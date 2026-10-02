import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFileSync,rmSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {MotionCoordinator} from '../src/motion/coordinator.ts';
import {MoveQueueSink} from '../src/motion/move-queue-sink.ts';
import {TrapQueue} from '../src/motion/trap-queue.ts';
const baseline='27855c1a',files=['coordinator','move-queue-sink'],temporary=files.map(name=>new URL(`../src/motion/.retire-baseline-${name}-${process.pid}.ts`,import.meta.url));
try{
 for(let i=0;i<files.length;i++)writeFileSync(temporary[i],execFileSync('git',['show',`${baseline}:host/src/motion/${files[i]}.ts`]),{flag:'wx'});
 const BeforeCoordinator=(await import(temporary[0].href) as {MotionCoordinator:typeof MotionCoordinator}).MotionCoordinator;
 const BeforeSink=(await import(temporary[1].href) as {MoveQueueSink:typeof MoveQueueSink}).MoveQueueSink;
 for(const active of [false,true]){
  const samples:number[][]=[[],[]];let expected:bigint|undefined;
  for(let round=0;round<24;round++)for(const index of round%2?[1,0]:[0,1]){
   const C=index?MotionCoordinator:BeforeCoordinator,S=index?MoveQueueSink:BeforeSink;
   using q=new TrapQueue();q.appendRaw(new Float64Array([0,0,1.2,0,0,0,0,active?1:0,0,0,active?10:0,active?10:0,0]));
   using stepper=q.createStepper({frequency:1e6,timeOffset:0,oid:1,maxError:0,queueStepTag:5,directionTag:6},'x',.01);
   let sum=0n;const sink=new S([{id:'m',emitters:['x'],moveSlots:512,clockAt:t=>stepper.clockAt(t),transport:{async send(packets){for(const p of packets)for(const byte of p.data)sum+=BigInt(byte);},async stop(){assert.fail('unexpected stop');}}}],async outputs=>{sum+=outputs[0].position;});
   const c=new C([{id:'x',queue:q,stepper}],sink),start=performance.now();for(let i=1;i<=100;i++)await c.advance(i/100);const elapsed=performance.now()-start;
   if(expected===undefined)expected=sum;assert.equal(sum,expected);if(round>=3)samples[index].push(elapsed);
  }
  for(const sample of samples)sample.sort((a,b)=>a-b);
  const stats=(v:number[])=>({medianMs:v[10],p95Ms:v[19]});
  console.log(JSON.stringify({node:process.version,baseline,active,windows:100,samples:21,checksum:String(expected),previous:stats(samples[0]),current:stats(samples[1]),scope:'native generation and sink commits, synthetic immediate transport; excludes serial ACK and physical printing'}));
  assert(samples[1][10]<=samples[0][10]*1.25,'Coordinator median regressed more than 25%');
 }
}finally{for(const file of temporary)rmSync(file,{force:true});}
