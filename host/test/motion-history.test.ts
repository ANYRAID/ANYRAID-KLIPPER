import test from 'node:test';
import assert from 'node:assert/strict';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {MotionCoordinator} from '../src/motion/coordinator.ts';
const settings={frequency:1e6,timeOffset:0,oid:3,maxError:0,queueStepTag:5,directionTag:6};
test('history expiry follows the slowest observed calibrated emitter rather than future generation',()=>{
 using a=new TrapQueue();using b=new TrapQueue();using x=a.createStepper(settings,'x',.01);using e=b.createStepper({...settings,frequency:2e6,timeOffset:-5,oid:4},'extruder',.01);let healthy=true;
 const c=new MotionCoordinator([{id:'x',queue:a,stepper:x},{id:'e',queue:b,stepper:e}],{async commit(){},async stop(){}},16*1024*1024,0,[{assertActive(){if(!healthy)throw new Error('expired samples');}}]);
 assert.equal(c.historyCutoff({x:100000000n,e:180000000n}),54.999);c.calibrateClock(['e'],0,2e6);assert.equal(c.historyCutoff({x:100000000n,e:180000000n}),59.999);assert.equal(c.historyCutoff({x:1000000n,e:2000000n}),0);
 assert.throws(()=>c.historyCutoff({x:100n}),/all emitters/);assert.throws(()=>c.historyCutoff({x:100n,foreign:100n}),/all emitters/);assert.throws(()=>c.historyCutoff({x:9007199254740992n,e:100n}),/exact mapping/);healthy=false;assert.throws(()=>c.historyCutoff({x:100n,e:100n}),/expired/);
});
test('rolling cleanup retains observed history while generation runs far ahead',async()=>{
 using q=new TrapQueue();const rows:number[]=[];for(let i=0;i<80;i++)rows.push(i,0,1,0,i,0,0,1,0,0,1,1,0);q.appendRaw(new Float64Array(rows));using x=q.createStepper(settings,'x',.1);let observed=40,commits=0,lastPosition=0n;
 const c=new MotionCoordinator([{id:'x',queue:q,stepper:x}],{async commit(b){commits++;lastPosition=b.outputs[0].position;},async stop(){}});const cutoff=()=>c.historyCutoff({x:BigInt(observed*1e6)});
 await c.advanceBounded(60,0,59.998,.25,cutoff);const data=q.extract(1000,0,100);const earliest=Math.min(...Array.from({length:data.length/10},(_,i)=>data[i*10]));assert.equal(earliest,9);assert.ok(q.extract(100,15,16).length>0);assert.ok(commits>1);
 observed=80;await c.advanceBounded(79.5,0,79.498,.25,cutoff);assert.equal(q.extract(100,15,16).length,0);assert.ok(q.extract(100,50,51).length>0);assert.equal(lastPosition,795n);
});
test('invalid history observation fails before committing a new window and fences the sink',async()=>{
 using q=new TrapQueue();q.appendRaw(new Float64Array([0,0,1,0,0,0,0,1,0,0,1,1,0]));using x=q.createStepper(settings,'x',.1);let commits=0,stops=0;const c=new MotionCoordinator([{id:'x',queue:q,stepper:x}],{async commit(){commits++;},async stop(){stops++;}});await assert.rejects(c.advanceBounded(1,0,1,.25,()=>NaN),/history cutoff/);assert.equal(commits,0);assert.equal(stops,1);assert.equal(c.status.generatedTime,0);
});
