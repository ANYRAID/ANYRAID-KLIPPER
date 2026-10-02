import {nativePrintFixture} from './native-linear-print.ts';
import {serialClock} from '../../src/protocol/serial-queue.ts';
/** Firmware trigger messages only: no synthetic grants of homing authority. */
export async function nativePrintHomingFixture(){
 const f=await nativePrintFixture('G1 X51.5 F600\n',false,true);f.options.startupHoming={mode:'home',axes:[0]};f.options.lifecycle.prepare=async()=>{};
 let hits=0;const timer=setInterval(()=>{
  const arms=f.t.f.fw.outputs.filter(m=>m.name==='endstop_home'&&Number(m.parameters.sample_count)>0),arm=arms[hits];if(!arm)return;
  const clock=Number(arm.parameters.clock);if(f.t.generation.members[0].session.clock.sync.getClock(serialClock.now())<BigInt(clock))return;
  hits++;f.t.f.fw.setTriggerReason(1,8);f.t.f.fw.setEndstopState({homing:0,pin_value:0,next_clock:clock+Number(arm.parameters.rest_ticks)},7);f.t.f.fw.emit('trsync_state',{oid:8,can_trigger:0,trigger_reason:1,clock});
 },1);
 return {f,get hits(){return hits;},stopTriggers(){clearInterval(timer);},async close(){clearInterval(timer);await f.close();}};
}
