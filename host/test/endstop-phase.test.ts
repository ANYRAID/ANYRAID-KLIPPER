import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {EndstopPhaseAlignment,endstopPhaseStatistics,type EndstopPhaseOptions} from '../src/homing/endstop-phase.ts';
const reference=JSON.parse(readFileSync(new URL('../contracts/endstop-phase-reference.json',import.meta.url),'utf8')) as {
 sourceSha256:string;rows:{options:EndstopPhaseOptions;accuracy:number;samples:{trigger:string;endstop:number;correction:number|null;error:boolean;phase:number;learned:number}[];history:string[]}[];
 statistics:{history:string[];expected:{phase:number;phases:number;low:number;high:number}}[];
};
test('48 original configurations preserve corrections, learning, errors and exact trigger histories',()=>{
 assert.equal(reference.rows.length,48);
 for(const row of reference.rows){
  const phase=new EndstopPhaseAlignment(row.options);assert.equal(phase.status.accuracy,row.accuracy);
  for(const sample of row.samples){
   const run=()=>phase.adjust(BigInt(sample.trigger),3,sample.endstop);
   if(sample.error)assert.throws(run,/accuracy/);else assert.equal(run(),sample.correction);
   assert.equal(phase.status.triggerPhase,sample.learned);assert.deepEqual(phase.status.last,{phase:sample.phase,mcuPosition:BigInt(sample.trigger)});
  }
  assert.deepEqual(phase.history,row.history.map(BigInt));
 }
});
test('287 original circular histograms preserve ties and wraparound with exact integer costs',()=>{
 assert.equal(reference.statistics.length,287);
 for(const row of reference.statistics){
  const history=row.history.map(BigInt),result=endstopPhaseStatistics(history),{cost,samples,...selection}=result;
  assert.deepEqual(selection,row.expected);assert.equal(samples,history.reduce((a,b)=>a+b,0n));
  // Independent circular-distance definition, not the sliding recurrence.
  const expectedCost=history.reduce((sum,count,index)=>{const delta=Math.abs(index-result.phase);return sum+count*BigInt(Math.min(delta,history.length-delta));},0n);
  assert.equal(cost,expectedCost);
 }
});
test('invalid observations never learn a phase or mutate history',()=>{
 const phase=new EndstopPhaseAlignment({microsteps:16,stepDistance:.01});
 for(const offset of [null,-1,64,.5,NaN])assert.throws(()=>phase.adjust(0n,offset,0));
 assert.throws(()=>phase.adjust(0n,0,Infinity));assert.equal(phase.status.last,null);assert.equal(phase.status.triggerPhase,null);assert(phase.history.every(n=>n===0n));
 const history=phase.history;phase.adjust(1n,0,0);assert(history.every(n=>n===0n));assert(Object.isFrozen(phase.status.last));
 for(const options of [{microsteps:3,stepDistance:.01},{microsteps:16,stepDistance:0},{microsteps:16,stepDistance:.01,accuracy:1},{microsteps:16,stepDistance:.01,triggerPhase:{phase:-1,phases:64}}])assert.throws(()=>new EndstopPhaseAlignment(options));
 for(const histogram of [[],[0n,0n,0n,0n],[1n,-1n,0n,0n]])assert.throws(()=>endstopPhaseStatistics(histogram));
});
test('statistics keep costs beyond safe integers and deterministic equal-cost phase order',()=>{
 const count=1n<<70n,result=endstopPhaseStatistics([count,count,count,count]);
 assert.deepEqual(result,{phase:2,phases:4,low:0,high:3,cost:count*4n,samples:count*4n});
 const asymmetric=endstopPhaseStatistics([count+1n,count,count,count]);assert.equal(asymmetric.phase,0);assert.equal(asymmetric.cost,count*4n);
});
test('statistics-only observations neither learn a correction nor enforce a trigger tolerance',()=>{
 const p=new EndstopPhaseAlignment({microsteps:16,stepDistance:.01});p.observe(0n,0);p.observe(32n,0);assert.equal(p.status.triggerPhase,null);assert.equal(p.history[0],1n);assert.equal(p.history[32],1n);assert.equal(p.status.last?.mcuPosition,32n);
});
test('cached calibration is immutable and invalidates on every observation',()=>{
 const p=new EndstopPhaseAlignment({microsteps:16,stepDistance:.01});const statistics=()=>p.statistics;assert.equal(statistics(),null);p.observe(0n,0);const first=statistics()!;assert(Object.isFrozen(first));assert.equal(statistics(),first);assert.equal(first.samples,1n);p.observe(1n,0);const next=statistics()!;assert.notEqual(next,first);assert.equal(next.samples,2n);assert.equal(first.samples,1n);assert.deepEqual(next,endstopPhaseStatistics(p.history));
});
