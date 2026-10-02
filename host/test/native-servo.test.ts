import test from 'node:test';
import assert from 'node:assert/strict';
import {configuredPrinterFixture} from './helpers/configured-printer.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {planLinearPrinter} from '../src/config/linear-printer.ts';
import {startConfiguredPrinter} from '../src/runtime/configured-printer.ts';
test('two MCU servos preserve initial pulses, motion junctions, angle zero and explicit pulse shutdown',async()=>{
 const f=await configuredPrinterFixture();let printer:Awaited<ReturnType<typeof startConfiguredPrinter>>|undefined;
 try{
  const reader=new ConfigurationReader(new ConfigurationSource('/servos.cfg',{...f.reader.source.original,
   'servo arm':{pin:'PA13',initial_angle:'90'},'servo latch':{pin:'aux:PA13'},
  },[]),null);
  const plan=planLinearPrinter(reader,{mcus:['mcu','aux'],enableLeadTime:.001,fanMinimumScheduleTime:.001});
  printer=await startConfiguredPrinter(reader,f.group,f.clocks,plan.layout,{...f.options,motion:plan.initial},f.signal);
  const p=printer;p.print.gcode.enable();p.linear.kinematics.markHomed([0]);
  const writes=(name:string)=>{const output=p.hardware.plan.outputPins.find(o=>o.settings.name===name)!;return f.firmware[output.mcu==='mcu'?0:1].outputs.filter(e=>e.parameters.oid===output.output.config.oid&&e.name==='queue_digital_out_generation').map(e=>Number(e.parameters.on_ticks));};
  assert.deepEqual(writes('arm'),[1500]);assert.deepEqual(writes('latch'),[]);
  const source=p.initial.generation.source,append=source.append.bind(source);let junction=0;
  source.append=moves=>{junction=Math.max(junction,moves[0]?.profile?.endV??0);append(moves);};
  await p.print.gcode.dispatch.execute('G1 X1 F600\nSET_SERVO SERVO=arm ANGLE=0\nSET_SERVO SERVO=latch WIDTH=0.002\nG1 X2 F600\nSET_SERVO SERVO=arm WIDTH=0');
  assert.ok(junction>0);assert.deepEqual(writes('arm'),[1500,1000,0]);assert.deepEqual(writes('latch'),[2000]);
  await p.print.gcode.dispatch.execute('SET_SERVO SERVO=latch WIDTH=0\nM400');assert.deepEqual(writes('latch'),[2000,0]);
  assert.ok(p.hardware.outputPins.every(o=>o.runtime.status.value===0));assert.deepEqual(f.stops,[0,0]);
  await p.close();assert.deepEqual(f.stops,[1,1]);assert.ok(p.hardware.outputPins.every(o=>o.runtime.status.phase==='stopped'));
 }finally{await printer?.close();await f.close();}
});
