import assert from 'node:assert/strict';
import {startConfiguredHardware} from '../src/runtime/configured-hardware.ts';
import {compileConfiguredHardware} from '../src/config/hardware.ts';
import {attachConfiguredAnalogHeater} from '../src/config/analog-heater.ts';
import {GenerationPWMOutput} from '../src/outputs/generation-pwm.ts';
import {ScheduledCoolingFan} from '../src/outputs/fan.ts';
import {MotorEnable} from '../src/outputs/motor-enable.ts';
import {AsyncPrinterHeaters} from '../src/thermal/async-heaters.ts';
import {hardwareStartupFixture} from '../test/helpers/hardware-startup.ts';
import {hardwareReader,hardwareLayout} from '../test/helpers/configured-hardware.ts';
const values={manual:{wall:[] as number[],cpu:[] as number[]},owned:{wall:[] as number[],cpu:[] as number[]}};
for(let run=0;run<14;run++)for(const mode of (run%2?['manual','owned']:['owned','manual']) as ('manual'|'owned')[]){
 const f=await hardwareStartupFixture();let close:undefined|(()=>Promise<void>);
 try{
  const used=process.cpuUsage(),start=performance.now();
  if(mode==='owned'){
   const owner=await startConfiguredHardware(hardwareReader(),f.group,f.clocks,hardwareLayout,{beforeTarget(){}},f.signal);close=owner.close;assert.equal(owner.status.state,'ready');assert(owner.heaters.status.started);assert(owner.analog[0].sensor.status.active);
  }else{
   const p=compileConfiguredHardware(hardwareReader(),f.group,f.clocks,hardwareLayout),heaters=new AsyncPrinterHeaters(()=>{}),analog=p.heaters.map(h=>{const a=attachConfiguredAnalogHeater(f.group,h);heaters.register(h.section,a.runtime);return a;});
   for(const c of p.configurations)await c.session.configure(c.plan,f.signal);
   new MotorEnable(f.group,p.motors.lines,p.motors.alwaysOn);
   const output=(o:typeof p.fans[number]['output'])=>new GenerationPWMOutput(o.pwm,f.group.session(o.mcu).dictionary,f.group.commandQueue(o.mcu),f.group.commandQueue(o.mcu),o.clock.clockAt,o.clock.printTimeAtClock);
   const fans=p.fans.map(f=>new ScheduledCoolingFan(output(f.output),f.config,f.enable?output(f.enable):undefined));for(const fan of fans)await fan.start(f.signal);
   await heaters.start(f.signal);for(const a of analog)a.sensor.activate();
   close=async()=>{await f.group.stop();await heaters.shutdown();await Promise.all(fans.map(fan=>fan.stop(new Error('benchmark complete'))));};
  }
  const wall=performance.now()-start,cpu=process.cpuUsage(used);assert.equal(f.group.session('mcu').configuration.moveSlots,511);assert.equal(f.group.session('aux').configuration.moveSlots,509);assert.equal(f.firmware[0].stepperConfigs.length,1);assert.equal(f.firmware[1].outputs.filter(o=>o.name==='reset_digital_out_generation').length,3);
  if(run>=3){values[mode].wall.push(wall);values[mode].cpu.push((cpu.user+cpu.system)/1000);}
 }finally{try{await close?.();}finally{await f.close();}}
}
const stats=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[5],p95Ms:v[10]};},manual={wall:stats(values.manual.wall),cpu:stats(values.manual.cpu)},owned={wall:stats(values.owned.wall),cpu:stats(values.owned.cpu)};
console.log(JSON.stringify({node:process.version,samples:11,manual,owned,scope:'Two native serial MCU emulators, full configuration and zero-output acknowledgements. Excludes connection handshake and stop; no physical printer proof.'}));
assert(owned.wall.medianMs<manual.wall.medianMs*1.5+5,'Hardware owner startup wall regression');assert(owned.cpu.medianMs<manual.cpu.medianMs*1.5+5,'Hardware owner startup CPU regression');
