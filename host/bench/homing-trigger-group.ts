import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {HomingTriggerGroup} from '../src/homing/trigger-group.ts';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {recoveryFixture} from '../test/helpers/homing-recovery.ts';
const f=await recoveryFixture(),signal=new AbortController().signal,times:number[][]=[[],[]];
try{
 for(let round=0;round<14;round++)for(const checked of round%2?[1,0]:[0,1]){
  const start=performance.now();for(let operation=0;operation<20;operation++){
   const clocks=f.sessions.map(s=>s.clock.sync.getClock(serialClock.now()+.075)),sampling=f.options.endstop.home({printTime:Number(clocks[0])/1e6,sampleTime:.000015,sampleCount:4,restTime:.001,trsyncOid:8},t=>BigInt(Math.round(t*1e6)));
   let release:()=>void;
   if(checked){const group=new HomingTriggerGroup(f.options.members,0,f.options.endstop,sampling,clocks,.25);release=()=>group.release();try{await group.arm(signal);}catch(error){release();throw error;}}
   else{
    const plans=f.options.members.map((m,i)=>m.trigger.start(clocks[i],m.steppers.map(s=>s.oid),.25,i/2)),group=SerialSession.createTriggerDispatch(f.options.members.map((m,i)=>({session:m.session,queue:m.queue,protocol:m.trigger,plan:plans[i]})));release=()=>group.close();
    try{await Promise.all(f.options.members.map(async(m,i)=>{for(const p of plans[i].packets)await m.queue.send(p.data,p.min,p.req,signal);}));group.start();await f.options.members[0].queue.send(sampling.payload,0n,sampling.reqClock,signal);}catch(error){release();throw error;}
   }
   try{await f.options.members[0].queue.send(f.options.endstop.stop(),0n,0n,signal);}finally{release();}
   await Promise.all(f.options.members.map(m=>m.session.queryOnQueue(m.queue,m.trigger.trigger(2),'trsync_state',signal,{oid:m.trigger.oid})));
  }
  if(round>=3)times[checked].push(performance.now()-start);
 }
 times.forEach(t=>t.sort((a,b)=>a-b));assert.equal(f.stops,0);
 console.log(JSON.stringify({node:process.version,operations:20,mcus:2,rawMedianMs:times[0][5],rawP95Ms:times[0][10],managedMedianMs:times[1][5],managedP95Ms:times[1][10],scope:'same native dispatch setup and simulated serial arm/stop command sequence; excludes physical homing and real watchdog timing'}));assert(times[1][5]<=times[0][5]*1.5,'Managed arm overhead exceeded 50%');
}finally{await f.close();}
