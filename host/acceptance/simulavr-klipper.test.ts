import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,openSync,closeSync,constants} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {runAVR} from '../src/simulator/run.ts';
import {SerialSession} from '../src/protocol/serial-session.ts';
test('real Klipper AVR firmware identifies, calibrates clocks and executes scheduled GPIO and steps through Node PTY', {timeout:30000},async t=>{
 const offset=Number(process.env.AVR_GPIO_OFFSET_TICKS??0);if(offset!==0&&offset!==8000)throw new Error('GPIO offset must be 0 or 8000 ticks');
 const elf=process.env.AVR_FIRMWARE;if(!elf)throw new Error('Set AVR_FIRMWARE to an atmega644p Klipper ELF built with CONFIG_SIMULAVR=y');
 const dir=mkdtempSync(join(tmpdir(),'avr-klipper-')),port=join(dir,'serial'),trace=join(dir,'gpio.vcd'),abort=new AbortController(),ready=Promise.withResolvers<void>();
 const run=runAVR({binary:fileURLToPath(new URL('../build/avrsim',import.meta.url)),elf,port,machine:'atmega644',speed:16000000,baud:250000,rate:1,trace:{file:trace,signals:'PORTA.PORT'}},abort.signal,()=>ready.resolve());
 void run.catch(error=>ready.reject(error));let fd:number|undefined,session:SerialSession|undefined;
 const signal=AbortSignal.timeout(20000),started=performance.now();
 try{
  await ready.promise;fd=openSync(port,constants.O_RDWR|constants.O_NONBLOCK|constants.O_NOCTTY);
  session=new SerialSession(fd,{async stopDevice(){abort.abort();await run;}});await session.initialize(signal);
  assert.equal(session.status.state,'ready');assert.equal(Number(session.dictionary.constant('CLOCK_FREQ')),16000000);
  const initializedMs=performance.now()-started;
  const config=await session.configure({oidCount:2,commands:['config_digital_out oid=0 pin=PA0 value=0 default_value=0 max_duration=0','config_stepper oid=1 step_pin=PA1 dir_pin=PA2 invert_step=0 step_pulse_ticks=32']},signal);
  assert.ok(config.moveCount>0);const queue=session.commandQueue();
  const uptime=async()=>{const response=await session!.query(session!.dictionary.encode('get_uptime',{}),'uptime',signal);return BigInt(Number(response.message.parameters.high))*0x100000000n+BigInt(Number(response.message.parameters.clock));};
  const before=await uptime(),on=before+1600000n,off=on+800000n+BigInt(offset);
  await queue.send(session.dictionary.encode('queue_digital_out',{oid:0,clock:Number(on&0xffffffffn),on_ticks:1}),0n,on,signal);
  await queue.send(session.dictionary.encode('reset_step_clock',{oid:1,clock:Number(on&0xffffffffn)}),0n,on,signal);
  await queue.send(session.dictionary.encode('set_next_step_dir',{oid:1,dir:1}),0n,on,signal);
  await queue.send(session.dictionary.encode('queue_step',{oid:1,interval:16000,count:100,add:0}),0n,on,signal);
  await queue.send(session.dictionary.encode('queue_digital_out',{oid:0,clock:Number(off&0xffffffffn),on_ticks:0}),0n,off,signal);
  while(await uptime()<on+1760000n){signal.throwIfAborted();await delay(20);}
  const position=await session.query(session.dictionary.encode('stepper_get_position',{oid:1}),'stepper_position',signal,{oid:1});
  assert.equal(position.message.parameters.pos,100);
  const frequency=session.clock.sync.estimate.frequency;await session.stop();await run;
  const text=readFileSync(trace,'utf8');let time=0n;const edges:{time:bigint;value:string}[]=[];
  for(const line of text.split('\n')){if(/^#\d+$/.test(line))time=BigInt(line.slice(1));else if(/^b[01]+ /.test(line))edges.push({time,value:line.split(' ')[0]});}
  const transitions=(mask:number)=>edges.filter((e,i)=>i>0&&((parseInt(e.value.slice(1),2)^parseInt(edges[i-1].value.slice(1),2))&mask));
  const digital=transitions(1);assert.equal(digital.length,2);
  const width=Number(digital[1].time-digital[0].time);
  const steps=transitions(2).filter(e=>(parseInt(e.value.slice(1),2)&2)!==0);assert.equal(steps.length,100);
  const deviations=steps.slice(1).map((e,i)=>Number(e.time-steps[i].time)-16000*62);
  const maxStepDeviationNs=Math.max(...deviations.map(Math.abs));
  const evidence={gpioOffsetTicks:offset,stepTimes:steps.map(e=>String(e.time)),deviations,maxStepDeviationNs,onClock:String(on),offClock:String(off),frequency};
  if(process.env.AVR_EVIDENCE){writeFileSync(process.env.AVR_EVIDENCE+'.vcd',text);writeFileSync(process.env.AVR_EVIDENCE+'.json',JSON.stringify(evidence,null,2)+'\n');}
  assert.ok(maxStepDeviationNs<10000,JSON.stringify(evidence));
  // Firmware timer interrupts add small instruction latency to each edge.
  assert.ok(Math.abs(width-(800000+offset)*62)<10000,`Unexpected pulse width ${width}`);
  t.diagnostic(JSON.stringify({initializedMs,calibratedClockHz:frequency,nominalClockHz:16000000,configuredCRC:config.crc,moveCount:config.moveCount,onClock:String(on),offClock:String(off),stepCount:steps.length,maxStepDeviationNs,observedPulseNs:width,expectedPulseNs:(800000+offset)*62,totalMs:performance.now()-started}));
 }finally{try{await session?.stop();}finally{abort.abort();await run.catch(()=>{});if(fd!==undefined)closeSync(fd);rmSync(dir,{recursive:true,force:true});}}
});
