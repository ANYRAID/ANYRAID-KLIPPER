import test from 'node:test';
import assert from 'node:assert/strict';
import {startConfiguredHardware} from '../src/runtime/configured-hardware.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {hardwareStartupFixture} from './helpers/hardware-startup.ts';
import {hardwareReader,hardwareLayout} from './helpers/configured-hardware.ts';
import {encodeFrame} from '../src/protocol/codec.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
const layout={...hardwareLayout,outputPins:['light','duty','soft'].map(name=>({section:`output_pin ${name}`}))};
const reader=(pin='!PA4')=>new ConfigurationReader(new ConfigurationSource('/outputs.cfg',{
 ...hardwareReader().source.original,
 'output_pin light':{pin,value:'1'},
 'output_pin duty':{pin:'aux:PA4',pwm:'true',hardware_pwm:'true',scale:'255',value:'127.5',shutdown_value:'63.75'},
 'output_pin soft':{pin:'aux:PA5',pwm:'true',value:'.4'},
},[]),null);

test('mixed output pins share hardware ownership and start only after all MCU configuration',async t=>{
 const f=await hardwareStartupFixture(false,false,true);
 try{
  const aux=f.group.session('aux'),configure=aux.configure.bind(aux);
  aux.configure=async(...args)=>{
   assert.equal(f.group.session('mcu').status.configured,true);
   assert.ok(!f.firmware[0].outputs.some(e=>e.name==='queue_digital_out_generation'));
   const digital=f.firmware[0].outputs.find(e=>e.name==='config_digital_out'&&e.parameters.oid===4)!;
   assert.equal(digital.parameters.value,1);assert.equal(digital.parameters.default_value,1);
   return configure(...args);
  };
  const start=performance.now();
  const h=await startConfiguredHardware(reader(),f.group,f.clocks,layout,{beforeTarget(){}},f.signal);
  t.diagnostic(JSON.stringify({startupMs:performance.now()-start,scope:'Two simulated MCUs with stepper, heater, fan and three output pins'}));
  assert.equal(h.outputPins.length,3);assert.equal(h.status.state,'ready');
  assert.deepEqual(h.plan.configurations.map(c=>[c.plan.oidCount,c.plan.reservedMoves]),[[5,2],[7,5]]);
  const expected=[0,128,40000];
  for(const [i,p] of h.plan.outputPins.entries()){
   const fw=f.firmware[p.mcu==='mcu'?0:1],events=fw.outputs.filter(e=>e.parameters.oid===p.output.config.oid);
   const reset=events.findIndex(e=>e.name.startsWith('reset_'));
   const write=events.findLastIndex(e=>e.name.startsWith('queue_')&&e.name.endsWith('_generation'));
   assert.ok(reset>=0&&write>reset);
   assert.equal(events[write].parameters[p.settings.hardware?'value':'on_ticks'],expected[i]);
   assert.equal(h.outputPins[i].output.runtime.status.phase,'ready');
   assert.ok(p.timeline!.status.reservedThrough>0n);
  }
  for(const [i,p] of h.plan.outputPins.entries()){
   const runtime=h.outputPins[i].runtime,session=f.group.session(p.mcu);
   const time=p.clock.printTimeAtClock(session.clock.sync.getClock(serialClock.now()))+.5;
   runtime.enqueue(time,p.settings.pwm?p.settings.scale*.75:0);await runtime.flush(time+.2,f.signal);
   assert.equal(runtime.status.pending,0);
   const fw=f.firmware[p.mcu==='mcu'?0:1],write=fw.outputs.filter(e=>e.parameters.oid===p.output.config.oid).at(-1)!;
   assert.equal(write.parameters[p.settings.hardware?'value':'on_ticks'],[1,191,75000][i]);
  }
  await f.group.stop(new Error('lost controller'));await h.close();
  assert.deepEqual(f.stops,[1,1]);
  assert.ok(h.outputPins.every(p=>p.output.runtime.status.phase==='failed'));
  assert.ok(h.outputPins.every(p=>p.runtime.status.phase==='stopped'));
 }finally{await f.close();}
});

test('output pin collision has no IO and can be corrected before hardware transfer',async()=>{
 const f=await hardwareStartupFixture(false,false,true);
 try{
  await assert.rejects(startConfiguredHardware(reader('STEP'),f.group,f.clocks,layout,{beforeTarget(){}},f.signal),/used multiple times|exclusively/);
  assert.deepEqual(f.stops,[0,0]);assert.ok(f.firmware.every(f=>f.outputs.length===0));
  const h=await startConfiguredHardware(reader(),f.group,f.clocks,layout,{beforeTarget(){}},f.signal);await h.close();
 }finally{await f.close();}
});

test('second MCU configuration failure never schedules the requested initial output',async()=>{
 const f=await hardwareStartupFixture(false,false,true);
 try{
  f.group.session('aux').configure=async()=>{throw new Error('configuration failed');};
  await assert.rejects(startConfiguredHardware(reader(),f.group,f.clocks,layout,{beforeTarget(){}},f.signal),/configuration failed/);
  assert.deepEqual(f.stops,[1,1]);
  assert.ok(!f.firmware.flatMap(f=>f.outputs).some(e=>e.name.endsWith('_generation')));
  const digital=f.firmware[0].outputs.find(e=>e.name==='config_digital_out'&&e.parameters.oid===4)!;
  assert.equal(digital.parameters.value,1);
 }finally{await f.close();}
});

test('one output reset failure stops both MCUs and settles concurrent startup', {timeout:5000},async()=>{
 const f=await hardwareStartupFixture(false,false,true);
 try{
  const commandQueue=f.group.commandQueue.bind(f.group);
  f.group.commandQueue=(id)=>{
   const queue=commandQueue(id);
   return {stop:cause=>queue.stop(cause),send(payload,min,req,signal){
    const message=f.group.session(id).dictionary.parseFrame(encodeFrame(0,payload))[0];
    if(message.name==='reset_pwm_out_generation')return Promise.reject(new Error('output reset failed'));
    return queue.send(payload,min,req,signal);
   }};
  };
  await assert.rejects(startConfiguredHardware(reader(),f.group,f.clocks,layout,{beforeTarget(){}},f.signal),/output reset failed|closed|stopped/);
  assert.deepEqual(f.stops,[1,1]);assert.equal(f.group.status.state,'stopped');
 }finally{await f.close();}
});
