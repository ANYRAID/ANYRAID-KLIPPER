import assert from 'node:assert/strict';
import {FrameDecoder} from '../../src/protocol/codec.ts';
import {Thermistor} from '../../src/thermal/thermistor.ts';
import type {productTransports} from './product-transports.ts';
/** Test-only endstop/ADC model at the firmware wire boundary, with no host hooks. */
export function simulateDeltaWire(transport:Awaited<ReturnType<typeof productTransports>>){
 const passes=new Map<string,number>(),timers=new Set<ReturnType<typeof setTimeout>>(),listeners:(()=>void)[]=[];
 const converter=new Thermistor(4700,0,{points:[[25,100000],[150,1770],[250,230]]});
 for(const [index,fw] of transport.firmware.entries()){
  const decoder=new FrameDecoder();let sequence=1;
  const onData=(chunk:Buffer|string)=>{for(const frame of decoder.push(typeof chunk==='string'?Buffer.from(chunk):chunk)){
   if((frame[1]&15)!==sequence)continue;sequence=(sequence+1)&15;
   for(const command of fw.dictionary.parseFrame(frame)){
    const p=command.parameters;
    if(command.name==='trsync_start'&&p.report_ticks===0)fw.setTriggerReason(2,Number(p.oid));
    if(command.name!=='endstop_home'||!Number(p.sample_count))continue;
    const cfg=fw.outputs.find(o=>o.name==='config_endstop'&&o.parameters.oid===p.oid);assert(cfg);
    const tower=index===1?'b':Number(cfg.parameters.pin)===3||/^PA3(?:_ALIAS)?$/.test(String(cfg.parameters.pin))?'a':'c';
    const stepPin=tower==='a'?0:tower==='b'?6:9,motor=fw.stepperConfigs.find(s=>Number(s.step_pin)===stepPin||s.step_pin==='PA'+stepPin);assert(motor);
    const pass=(passes.get(tower)??0)+1;passes.set(tower,pass);
    const hit=Number(p.clock)+(pass===1?50000:15000)+['a','b','c'].indexOf(tower)*4000;
    const timer=setTimeout(()=>{timers.delete(timer);fw.setStepperPosition(Number(motor.oid),pass*50);fw.setTriggerReason(1,Number(p.trsync_oid));fw.setEndstopState({homing:0,pin_value:0,next_clock:hit+Number(p.rest_ticks)},Number(p.oid));fw.emit('trsync_state',{oid:Number(p.trsync_oid),can_trigger:0,trigger_reason:1,clock:hit});},Math.max(0,(hit-fw.currentClock())/1000+10));timers.add(timer);
   }
  }};
  fw.peer.on('data',onData);listeners.push(()=>fw.peer.off('data',onData));
 }
 const thermal=setInterval(()=>{for(const fw of transport.firmware)for(const entry of fw.outputs.filter(o=>o.name==='query_analog_in'&&Number(o.parameters.rest_ticks)>0)){
  const p=entry.parameters,cfg=fw.outputs.find(o=>o.name==='config_analog_in'&&o.parameters.oid===p.oid);if(!cfg)continue;
  const temperature=cfg.parameters.pin==='PA2'||cfg.parameters.pin===2?220:80,raw=Math.round(converter.adc(temperature)*4095*Number(p.sample_count)),next=fw.currentClock()+Number(p.rest_ticks)-Number(p.sample_ticks)*Number(p.sample_count);
  fw.emit('analog_in_state',{oid:Number(p.oid),next_clock:next>>>0,values:Buffer.from([raw&255,raw>>8])});
 }},10);
 return {passes,close(){clearInterval(thermal);for(const timer of timers)clearTimeout(timer);for(const off of listeners)off();}};
}
