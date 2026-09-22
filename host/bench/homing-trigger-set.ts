import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {HomingTriggerGroup} from '../src/homing/trigger-group.ts';
import {HomingTriggerSet} from '../src/homing/trigger-set.ts';
import {EndstopProtocol} from '../src/inputs/endstop.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {recoveryFixture} from '../test/helpers/homing-recovery.ts';
const f=await recoveryFixture(),signal=new AbortController().signal,times:number[][]=[[],[]];
const endstops=f.sessions.map(session=>{const chip={};return new EndstopProtocol(chip,session.dictionary,7,{chip,chipName:'mcu',pin:'PA0',invert:0,pullup:1});});
try{
 for(let round=0;round<14;round++)for(const managed of round%2?[1,0]:[0,1]){
  const start=performance.now();for(let operation=0;operation<20;operation++){
   const groups=f.options.members.map((m,i)=>{const clock=m.session.clock.sync.getClock(serialClock.now()+.075),sampling=endstops[i].home({printTime:Number(clock)/1e6,sampleTime:.000015,sampleCount:4,restTime:.001,trsyncOid:8},t=>BigInt(Math.round(t*1e6)));return new HomingTriggerGroup([m],0,endstops[i],sampling,[clock],.25);});
   const set=managed?new HomingTriggerSet(groups):undefined;
   try{
    if(set)await set.arm(signal);else await Promise.all(groups.map(g=>g.arm(signal)));
    for(const fw of f.fs)fw.emit('trsync_state',{oid:8,can_trigger:0,trigger_reason:1,clock:0});
    const results=set?await set.wait(signal):await Promise.all(groups.map(g=>g.completion));assert.deepEqual(results.map(r=>r.reason),[1,1]);
    await Promise.all(f.options.members.map((m,i)=>m.queue.send(endstops[i].stop(),0n,0n,signal)));
   }finally{if(set)set.release();else for(const g of groups)g.release();}
   await Promise.all(f.options.members.map(m=>m.session.queryOnQueue(m.queue,m.trigger.trigger(2),'trsync_state',signal,{oid:8})));
  }
  if(round>=3)times[managed].push(performance.now()-start);
 }
 times.forEach(t=>t.sort((a,b)=>a-b));assert.equal(f.stops,0);console.log(JSON.stringify({node:process.version,groups:2,operations:20,rawMedianMs:times[0][5],rawP95Ms:times[0][10],managedMedianMs:times[1][5],managedP95Ms:times[1][10],scope:'same two independent native trigger groups and simulated arm/complete/stop sequence, no physical limit switches or movement'}));assert(times[1][5]<=times[0][5]*1.5,'Trigger set overhead exceeded 50%');
}finally{await f.close();}
