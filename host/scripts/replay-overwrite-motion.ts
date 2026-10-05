import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Move,motionLimits,type Trapezoid} from '../src/motion/lookahead.ts';
import {representableProfile,representableSplitProfile} from '../src/motion/representable-profile.ts';
import {TrapQueue} from '../src/motion/trap-queue.ts';
const capture=JSON.parse(await readFile(new URL('../contracts/motion-overwrite-capture.json',import.meta.url),'utf8'));
for(const [index,entry] of [capture,...capture.additionalFailures??[]].entries()){
 const input=entry.input;
 const move=new Move(motionLimits(100,input.move.accel),input.move.start,input.move.end,input.move.profile.cruiseV);
 move.accel=input.move.accel;move.profile={...input.move.profile} as Trapezoid;
 assert.equal(move.distance,input.move.distance);assert.deepEqual(move.axesR,input.move.ratio);
 const time=input.row[0],normalization=representableProfile(move,time),split=normalization?undefined:representableSplitProfile(move,time);
 const report:Record<string,unknown>={index,state:'unresolved',scope:'Replay of one captured planned move against the actual native queue; not complete motion precision acceptance',inputDistance:input.move.distance,reconstructedDistance:move.distance,inputRatio:input.move.ratio,reconstructedRatio:move.axesR,normalization:normalization??null,split:split??null};
 using queue=new TrapQueue();
 try{report.end=queue.appendPlanned([move],time);report.state='capture_no_longer_rejects';report.rows=Array.from(queue.extract(10,time,Number(report.end)+1));}
 catch(error){report.error=String(error);report.atomicQueueEmpty=queue.extract(10,0,time+1).length===0;process.exitCode=1;}
 using relativeQueue=new TrapQueue();
 try{report.relativeEnd=relativeQueue.appendPlanned([move],0);report.relativeRows=Array.from(relativeQueue.extract(10,0,Number(report.relativeEnd)+1));}
 catch(error){report.relativeError=String(error);}
 console.log(JSON.stringify(report));
}
