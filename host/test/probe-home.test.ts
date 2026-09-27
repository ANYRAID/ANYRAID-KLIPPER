import {FrameDecoder} from '../src/protocol/codec.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {probeHomingPosition} from '../src/homing/probe-home.ts';
import {nativeLinearFixture} from './helpers/native-linear-port.ts';
import type {LinearHomingSeek} from '../src/homing/linear-seek.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
const signal=()=>new AbortController().signal;
test('probe homing shifts only Z by measured bed height and preserves halt overshoot',()=>{
 const halt=[10,20,123.42,7],trigger=[10,20,123.4,7],result=probeHomingPosition(halt,trigger,1.25);
 assert.deepEqual(result,[10,20,123.42-(123.4-1.25),7]);assert.deepEqual(halt,[10,20,123.42,7]);assert.throws(()=>probeHomingPosition(halt,trigger,Infinity));
});
for(const {xy,retract,stuck=false} of [{xy:false,retract:0},{xy:true,retract:0},{xy:true,retract:1},{xy:true,retract:1,stuck:true}])test(`native probe Z home validates trigger, retract and authority (xy=${xy} retract=${retract} stuck=${stuck})`,async()=>{
 const t=await nativeLinearFixture(retract,()=>false,false,undefined,false,false,false,{pin:'PA13',z_offset:'1.25'},undefined,undefined,true);let sent=false,hits=0,expectedZ:number|undefined;
 const home=t.port.home.bind(t.port);t.port.home=async(...args)=>{const pass=await home(...args),raw=pass as Awaited<ReturnType<LinearHomingSeek['run']>>;expectedZ=raw.position[2]-(raw.triggerPosition[2]-1.25);return pass;};
 const decoder=new FrameDecoder();let sequence=1;t.f.fw.peer.on('data',chunk=>{for(const frame of decoder.push(typeof chunk==='string'?Buffer.from(chunk):chunk)){if((frame[1]&15)!==sequence)continue;sequence=(sequence+1)&15;for(const c of t.f.fw.dictionary.parseFrame(frame))if(c.name==='trsync_start'&&c.parameters.report_ticks===0)t.f.fw.setTriggerReason(2,Number(c.parameters.oid));}});
 const timer=setInterval(()=>{
  if(t.port.status.phase==='retract'){t.f.fw.setStepperPosition(2,100);return;}
  const arm=t.f.fw.outputs.filter(m=>m.name==='endstop_home'&&Number(m.parameters.sample_count)>0)[hits];if(!arm)return;
  const clock=BigInt(Number(arm.parameters.clock))+(hits&&stuck?0n:30000n);if(t.f.options.members[0].session.clock.sync.getClock(serialClock.now())<clock)return;sent=true;
  t.f.fw.setStepperPosition(2,hits?stuck?100:95:-5);hits++;t.f.fw.setTriggerReason(1,8);t.f.fw.setEndstopState({homing:0,pin_value:0,next_clock:Number(clock)+Number(arm.parameters.rest_ticks)},7);t.f.fw.emit('trsync_state',{oid:8,can_trigger:0,trigger_reason:1,clock:Number(clock)});
 },1);
 try{
  if(xy){t.kinematics.markHomed([0,1]);if(stuck){await assert.rejects(t.command.home([2],signal()),/still triggered/);assert.equal(t.kinematics.status.homedAxes,'');assert.equal(t.f.stops,1);assert.equal(hits,2);return;}await t.command.home([2],signal());assert.equal(hits,retract?2:1);assert(sent);assert.equal(t.kinematics.status.homedAxes,'xyz');assert.deepEqual(t.port.position().filter((_,i)=>i!==2),[50,0,2]);assert.notEqual(expectedZ,undefined);assert.equal(t.port.position()[2],expectedZ);assert.notEqual(expectedZ,1.25,'Physical stop overshoot must remain in the Z coordinate');assert.equal(t.f.stops,0);}
  else{await assert.rejects(t.command.home([2],signal()),/homed XY/);assert.equal(sent,false);assert.equal(t.kinematics.status.homedAxes,'');assert.equal(t.f.stops,1);}
 }finally{clearInterval(timer);await t.close();}
});

test('cancellation during probe Z descent revokes all homing and joins motor stop',async()=>{
 const t=await nativeLinearFixture(0,()=>false,false,undefined,false,false,false,{pin:'PA13',z_offset:'1.25'},undefined,undefined,true),abort=new AbortController();
 try{t.kinematics.markHomed([0,1]);const running=t.command.home([2],abort.signal),rejected=assert.rejects(running,/cancel probe/),deadline=Date.now()+3000;while(!t.f.fw.outputs.some(m=>m.name==='endstop_home'&&Number(m.parameters.sample_count)>0)){assert(Date.now()<deadline);await new Promise(r=>setTimeout(r,2));}abort.abort(new Error('cancel probe'));await rejected;assert.equal(t.kinematics.status.homedAxes,'');assert.equal(t.f.stops,1);assert(t.port.status.failed);}finally{await t.close();}
});

test('probe homing coordinate arithmetic matches 216 original Python boundary cases exactly',async()=>{
 const {readFileSync}=await import('node:fs');const reference=JSON.parse(readFileSync(new URL('../contracts/probe-home-reference.json',import.meta.url),'utf8')) as {rows:{halt:number[];trigger:number[];offset:number;expected:number[]}[]};assert.equal(reference.rows.length,216);
 for(const row of reference.rows)assert.deepEqual(probeHomingPosition(row.halt,row.trigger,row.offset),row.expected);
});
