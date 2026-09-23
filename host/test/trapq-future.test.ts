import test from 'node:test';
import assert from 'node:assert/strict';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {inputShaper} from '../src/motion/shaper.ts';
import {Move,LookAheadQueue,motionLimits} from '../src/motion/lookahead.ts';
import {planPathStop} from '../src/motion/path-stop.ts';
const settings={frequency:1e6,timeOffset:0,oid:3,maxError:0,queueStepTag:5,directionTag:6};
const brake=(cut=3,extrusion=false)=>new Float64Array([cut,0,0,1,extrusion?1.5:15,0,0,1,extrusion?1:0,0,extrusion?1:10,extrusion?1:10,extrusion?1:10,cut+1,0,.5,0,extrusion?2:20,0,0,0,0,0,0,0,0]);
for(const filtered of [false,true])for(const extrusion of [false,true])test(`future brake preserves native pulse prefix and filter history (filtered=${filtered}, E=${extrusion})`,()=>{
 function run(replace:boolean){
  using q=new TrapQueue();q.setPosition(0,0,0,0);using s=q.createStepper(settings,extrusion?'extruder':'x',.01);
  if(filtered){if(extrusion)s.configurePressureAdvance(.05,.04);else s.configureShapers({x:inputShaper('mzv',40,.1)});}
  s.initializePosition(0n,0n);const v=extrusion?1:10;
  q.appendRaw(new Float64Array([1,1,replace?10:1,0,0,0,0,1,extrusion?1:0,0,0,v,v]));if(!replace)q.appendRaw(brake(3,extrusion));
  s.generate(2.5);const prefix=s.flush();const before=q.extract(100,0,2.4);q.finalize(s.scanWindow.safeFinalizeTime!,0);
  if(replace)q.replaceFutureRaw(3,brake(3,extrusion));
  // Extracted rows can straddle the cut: only historical rows ending before it
  // are immutable in full. Their native data survives finalize and replacement.
  const history=q.extract(100,0,2.4);for(let i=0;i<before.length;i+=10)if(before[i]+before[i+1]<3)assert(history.some((_,j)=>j%10===0&&history.slice(j,j+10).every((v,k)=>v===before[i+k])));
  s.generate(4.4);const suffix=s.flush(),ticks:[bigint,bigint][]=[];
  for(const out of [prefix,suffix])for(let i=0;i<out.history.length;i+=6){const [first,,position,count,interval,add]=out.history.slice(i,i+6),n=count<0n?-count:count;for(let j=0n;j<n;j++)ticks.push([first+j*interval+add*j*(j+1n)/2n,position+(count<0n?-1n:1n)*(j+1n)]);}
  ticks.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);return {prefix,ticks,position:suffix.position};
 }
 const expected=run(false),actual=run(true);assert.deepEqual(actual.prefix,expected.prefix);assert.equal(actual.position,extrusion?200n:2000n);assert.equal(actual.position,expected.position);assert.equal(actual.ticks.length,expected.ticks.length);
 for(let i=0;i<actual.ticks.length;i++){assert.equal(actual.ticks[i][1],expected.ticks[i][1]);assert(actual.ticks[i][0]-expected.ticks[i][0]<=1n&&expected.ticks[i][0]-actual.ticks[i][0]<=1n);}
});
test('every attached solver protects its future window and rejected replacements are atomic',()=>{
 using q=new TrapQueue();q.setPosition(0,0,0,0);using x=q.createStepper(settings,'x',.01);using y=q.createStepper({...settings,oid:4},'y',.01);
 y.configureShapers({y:inputShaper('mzv',20,.1)});q.appendRaw(new Float64Array([1,1,10,1,0,0,0,1,1,0,0,10,10]));x.generate(2);y.generate(2.5);
 const before=q.extract(100,0,20),horizon=2.5+y.scanWindow.future;
 for(const cut of [1,2,2.5,horizon])assert.throws(()=>q.replaceFutureRaw(cut,brake(cut)),/dependencies/);
 const invalid=brake();invalid[15]=-1;assert.throws(()=>q.replaceFutureRaw(3,invalid),/invalid motion time/);
 assert.throws(()=>q.replaceFutureRaw(3,new Float64Array()),/start/);assert.throws(()=>q.replaceFutureRaw(3,brake(4)),/start/);
 assert.throws(()=>q.replaceFutureRaw(3,new Float64Array(new SharedArrayBuffer(26*8))),/batch/);
 assert.deepEqual(q.extract(100,0,20),before);q.replaceFutureRaw(3,brake());assert.doesNotThrow(()=>x.generate(4));
});
test('replacement at a phase boundary removes the old suffix and accepts later appends',()=>{
 using q=new TrapQueue();q.appendRaw(new Float64Array([1,1,10,1,0,0,0,1,0,0,0,10,10]));
 q.replaceFutureRaw(2,new Float64Array([2,0,0,1,5,0,0,1,0,0,10,10,10]));
 const rows=q.extract(100,0,20);assert.equal(rows.length,20);assert.equal(rows[0],2);assert.equal(rows[1],1);assert.equal(rows[10],1);
 q.appendRaw(new Float64Array([3,0,1,0,10,0,0,1,0,0,1,1,0]));assert.equal(q.extract(1,0,20)[0],3);
});
test('path stop plan replaces the owned future while the original compressor remains attached',()=>{
 const lookahead=new LookAheadQueue();lookahead.add(new Move(motionLimits(100,10,5,0),[0,0,0,0],[100,0,0,10],10));const path=lookahead.flush(),stop=planPathStop(path,2);
 using q=new TrapQueue();q.setPosition(0,0,0,0);using s=q.createStepper(settings,'x',.01);s.configureShapers({x:inputShaper('mzv',40,.1)});s.initializePosition(0n,0n);
 q.appendPlanned(path,1);s.generate(2.5);const prefix=s.flush();assert(prefix.position>0n&&prefix.position<2000n);
 const end=q.replaceFuturePlanned(stop.brake,3,undefined,true);assert.equal(end,4);q.appendRaw(new Float64Array([end,0,.5,0,...stop.position.slice(0,3),0,0,0,0,0,0]));s.generate(4.4);assert.equal(s.flush().position,2000n);
 const resume=new LookAheadQueue();resume.addBatch(stop.remainder);const tail=resume.flush();const finish=q.appendPlanned(tail,4.5,undefined,true);q.appendRaw(new Float64Array([finish,0,.5,0,100,0,0,0,0,0,0,0,0]));s.generate(finish+.4);assert.equal(s.flush().position,10000n);
});
