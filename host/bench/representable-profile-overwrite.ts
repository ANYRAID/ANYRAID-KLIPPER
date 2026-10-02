import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {Move,motionLimits} from '../src/motion/lookahead.ts';
import {representableProfile,representableSplitProfile} from '../src/motion/representable-profile.ts';
import {TrapQueue} from '../src/motion/trap-queue.ts';
const capture=JSON.parse(await readFile(new URL('../contracts/motion-overwrite-capture.json',import.meta.url),'utf8'));
const baselinePath=resolve(process.env.MOTION_PROFILE_BASELINE??'build/anyraid-overwrite-acceptance/baseline/host/src/motion/representable-profile.ts');
const baselineBytes=await readFile(baselinePath),baselineSha256=createHash('sha256').update(baselineBytes).digest('hex');assert.equal(baselineSha256,capture.sources['host/src/motion/representable-profile.ts']);
const baseline=(await import(pathToFileURL(baselinePath).href)).representableProfile as typeof representableProfile;
const queueBaselinePath=resolve(baselinePath,'../trap-queue.ts'),queueBaselineBytes=await readFile(queueBaselinePath),queueBaselineSha256=createHash('sha256').update(queueBaselineBytes).digest('hex');assert.equal(queueBaselineSha256,capture.sources['host/src/motion/trap-queue.ts']);
const OldQueue=(await import(pathToFileURL(queueBaselinePath).href)).TrapQueue as typeof TrapQueue;
assert.match(process.version,/^v26\./);
const input=capture.input,rare=new Move(motionLimits(100,1000),input.move.start,input.move.end,10);rare.profile={...input.move.profile};
const common=new Move(motionLimits(100,1000),[1,0,0,.1],[2,0,0,.2],10);common.setJunction(100,100,100);
const measure=(fn:typeof representableProfile,m:Move,time:number,count:number)=>{let resolved=0;const begin=performance.now();for(let n=0;n<count;n++)if(fn(m,time))resolved++;return {ms:performance.now()-begin,resolved};};
const commonTimes=[[],[]] as [number[],number[]],rareTimes=[[],[]] as [number[],number[]];
for(let n=0;n<3;n++)for(const fn of [baseline,representableProfile]){measure(fn,common,13,100000);measure(fn,rare,input.row[0],5000);}
for(let n=0;n<11;n++)for(const i of n%2?[1,0]:[0,1]){
 const fn=i?representableProfile:baseline,regular=measure(fn,common,13,100000),captured=measure(fn,rare,input.row[0],5000);
 assert.equal(regular.resolved,0);assert.equal(captured.resolved,i?5000:0);commonTimes[i].push(regular.ms);rareTimes[i].push(captured.ms);
}
const summary=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[5],p95Ms:values[10]};};
const regular=commonTimes.map(summary),captured=rareTimes.map(summary),limits={medianRatio:1.25,p95Ratio:1.5,slackMs:2};
assert(regular[1].medianMs<=regular[0].medianMs*limits.medianRatio+limits.slackMs);assert(regular[1].p95Ms<=regular[0].p95Ms*limits.p95Ratio+limits.slackMs);
const second=capture.additionalFailures[0].input,splitMove=new Move(motionLimits(100,1000),second.move.start,second.move.end,10);splitMove.profile={...second.move.profile};
const splitTimes:number[]=[];for(let n=0;n<14;n++){let resolved=0;const begin=performance.now();for(let i=0;i<5000;i++)if(representableSplitProfile(splitMove,second.row[0]))resolved++;assert.equal(resolved,5000);if(n>=3)splitTimes.push(performance.now()-begin);}
const batch=Array.from({length:100},(_,i)=>{const m=new Move(motionLimits(100,1000),[i/100,0,0,0],[(i+1)/100,0,0,0],10);m.setJunction(100,100,100);return m;}),queueTimes=[[],[]] as [number[],number[]];
const queueMeasure=(Queue:typeof TrapQueue)=>{const begin=performance.now();for(let i=0;i<100;i++){using queue=new Queue();const end=queue.appendPlanned(batch,13),row=queue.extract(1,13,end+1);assert.equal(row[4]+row[7]*(row[2]+.5*row[3]*row[1])*row[1],1);}return performance.now()-begin;};
for(let n=0;n<3;n++)for(const Queue of [OldQueue,TrapQueue])queueMeasure(Queue);
for(let n=0;n<11;n++)for(const i of n%2?[1,0]:[0,1])queueTimes[i].push(queueMeasure(i?TrapQueue:OldQueue));
const queues=queueTimes.map(summary);assert(queues[1].medianMs<=queues[0].medianMs*limits.medianRatio+limits.slackMs);assert(queues[1].p95Ms<=queues[0].p95Ms*limits.p95Ratio+limits.slackMs);
const packetResults=[];for(const Queue of [OldQueue,TrapQueue]){using queue=new Queue();const end=queue.appendPlanned(batch,13);using step=queue.createStepper({frequency:1e6,timeOffset:13,maxError:0,queueStepTag:5,directionTag:6,oid:3},'x',.00125);step.generate(end);packetResults.push(step.flush());}assert.deepEqual(packetResults[1],packetResults[0]);assert.equal(packetResults[0].position,800n);
console.log(JSON.stringify({node:process.version,baselinePath,baselineSha256,queueBaselineSha256,common:{callsPerSample:100000,baseline:regular[0],candidate:regular[1],limits},capture:{callsPerSample:5000,baseline:captured[0],candidate:captured[1],baselineResolved:0,candidateResolved:5000},secondCapture:{callsPerSample:5000,candidate:summary(splitTimes),candidateResolved:5000},nativeCommonQueue:{movesPerBatch:100,batchesPerSample:100,baseline:queues[0],candidate:queues[1],limits,identicalPackets:true,motorSteps:800},scope:'Alternating immutable old/new source math and actual native queue timing. Common-path gates reuse existing motion benchmark ratios/slack; captured paths differ in outcome and are measured separately. Not target-board or complete G3 acceptance.'}));
