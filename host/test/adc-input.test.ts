import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ADCInput,compileADC,legacyADCQuery,batchADCQuery,type ADCSample} from '../src/inputs/adc.ts';
import {MessageDictionary} from '../src/protocol/dictionary.ts';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialFirmware} from './helpers/serial-firmware.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {PrintClockTimeline} from '../src/timing/print-clock-timeline.ts';
function setup(legacy=false){const d=new MessageDictionary();d.identify(Buffer.from(JSON.stringify({commands:{'config_analog_in oid=%c pin=%u':27,[legacy?legacyADCQuery:batchADCQuery]:28},responses:{[legacy?'analog_in_state oid=%c next_clock=%u value=%hu':'analog_in_state oid=%c next_clock=%u values=%*s']:29},config:{CLOCK_FREQ:1e6,ADC_MAX:4095}})),false);const chip={},pin={chip,chipName:'mcu',pin:'PA0',invert:0 as const,pullup:0 as const};return {d,chip,base:{oid:3,pin,currentPrintTime:1,reportTime:.3,sampleTime:.001,sampleCount:8},clock:(t:number)=>BigInt(Math.trunc(t*1e6))};}
const message=(next:number,values:number[],oid=3)=>({name:'analog_in_state',parameters:{oid,next_clock:next,values:Buffer.from(values.flatMap(v=>[v&255,v>>8]))}});
test('ADC batch crossing calibration reads each historical segment and holds the consumer watermark',()=>{
 const x=setup(),c=compileADC(x.chip,x.d,{...x.base,batchCount:3},x.clock),clock=new PrintClockTimeline({offset:0,frequency:1e6});let samples:readonly ADCSample[]=[];
 const input=ADCInput.withClock(c,BigInt,clock,s=>{samples=s;});clock.append(1200000n,1100000);clock.retireBefore(1800000n);assert.equal(clock.status.fromClock,0n);
 input.receive(message(1800000,[0,16380,32760]));assert.deepEqual(samples,[[.9,0],[1.2,.5],[clock.printTimeAtClock(1500000n),1]]);
 assert(samples[2][0]<1.5);clock.retireBefore(1800000n);assert.equal(clock.status.fromClock,1200000n);
 input.close();assert.throws(()=>input.receive(message(2700000,[0,0,0])),/faulted/);
});
test('slow ADC consumer retains history until close or fault releases its lease',()=>{
 const x=setup(),c=compileADC(x.chip,x.d,x.base,x.clock),clock=new PrintClockTimeline({offset:0,frequency:1e6}),slow=ADCInput.withClock(c,BigInt,clock,()=>{}),fast=ADCInput.withClock(c,BigInt,clock,()=>{});
 clock.append(1000000n,1000100);clock.append(2000000n,999900);fast.receive(message(2700000,[1]));clock.retireBefore(2500000n);assert.equal(clock.status.fromClock,0n);
 assert.throws(()=>slow.receive(message(2700000,[65535])));clock.retireBefore(2500000n);assert.equal(clock.status.fromClock,2000000n);fast.close();slow.close();
});
test('ADC config uses original query slots, thresholds and legacy capability selection',()=>{
 const x=setup(true),c=compileADC(x.chip,x.d,{...x.base,minimum:.123,maximum:.789,rangeCheckCount:4},x.clock);assert.equal(c.legacy,true);assert.deepEqual(c.commands,['config_analog_in oid=3 pin=PA0']);assert.deepEqual(c.init,['query_analog_in oid=3 clock=2030000 sample_ticks=1000 sample_count=8 rest_ticks=300000 min_value=4029 max_value=25848 range_check_count=4']);assert.throws(()=>compileADC(x.chip,x.d,{...x.base,batchCount:2},x.clock),/mismatched/);
});
test('ADC rejects invalid pin, accumulation, sampling and limits before firmware configuration',()=>{
 const x=setup();for(const edit of [{sampleCount:17},{batchCount:25},{rangeCheckCount:256},{sampleTime:1e-8},{reportTime:.001},{minimum:NaN},{maximum:2},{pin:{...x.base.pin,invert:1 as const}}])assert.throws(()=>compileADC(x.chip,x.d,{...x.base,...edit},x.clock));
 const c=compileADC(x.chip,x.d,x.base,()=>0x100000000n);assert.match(c.init[0],/clock=30000 /);
});
test('batched ADC decodes every little-endian sample with distinct historical clock',()=>{
 const x=setup(),c=compileADC(x.chip,x.d,{...x.base,batchCount:3},x.clock);let samples:readonly ADCSample[]=[];const input=new ADCInput(c,n=>BigInt(n),n=>Number(n)/1e6,s=>{samples=s;});assert.equal(input.receive(message(1800000,[0,16380,32760])),true);assert.deepEqual(samples,[[.9,0],[1.2,.5],[1.5,1]]);assert.deepEqual(input.lastValue,[1.5,1]);assert.equal(input.receive(message(1800000,[0,0,0],4)),false);assert.throws(()=>input.receive(message(1800000,[0,0,0])),/repeated/);assert.equal(input.failed,true);
});
test('legacy ADC scalar reports preserve low32 wrap using the synchronized expansion',()=>{
 const x=setup(true),c=compileADC(x.chip,x.d,x.base,x.clock);const input=new ADCInput(c,n=>0x100000000n+BigInt(n),n=>Number(n)/1e6,()=>{});input.receive({name:'analog_in_state',parameters:{oid:3,next_clock:100000,value:16380}});assert.deepEqual(input.lastValue,[Number(0x100000000n-200000n)/1e6,.5]);
});
test('invalid final ADC samples and unrepresentable clocks cannot publish partial batches',()=>{
 const x=setup(),c=compileADC(x.chip,x.d,{...x.base,batchCount:2},x.clock);let calls=0;for(const bad of [message(1800000,[0,65535]),message(1800000,[0]),message(1800000,[])]){const input=new ADCInput(c,BigInt,n=>Number(n)/1e6,()=>calls++);assert.throws(()=>input.receive(bad));assert.deepEqual(input.lastValue,[0,0]);assert.throws(()=>input.receive(message(1800000,[0,0])),/faulted/);}const input=new ADCInput(c,BigInt,()=>1,()=>calls++);assert.throws(()=>input.receive(message(1800000,[0,0])),/mapping/);assert.equal(calls,0);
});
test('ADC consumer failure latches the input and prevents reuse',()=>{
 const x=setup(),input=new ADCInput(compileADC(x.chip,x.d,x.base,x.clock),BigInt,n=>Number(n)/1e6,()=>{throw new Error('sensor failure');});assert.throws(()=>input.receive(message(1800000,[12])),/sensor failure/);assert.throws(()=>input.receive(message(2100000,[12])),/faulted/);
});
test('native serial ADC config and reports route by OID and decoder failure stops the session',async()=>{
 const fw=await serialFirmware();let input:ADCInput|undefined,stops=0;let resolve!:(samples:readonly ADCSample[])=>void;const received=new Promise<readonly ADCSample[]>(r=>{resolve=r;});const s=new SerialSession(fw.fd,{async stopDevice(){stops++;},onMessage(r){input?.receive(r.message);}});
 try{const signal=new AbortController().signal;await s.initialize(signal);const x=setup(),now=Number(s.clock.sync.getClock(serialClock.now()))/1e6,c=compileADC(x.chip,s.dictionary,{...x.base,currentPrintTime:now,batchCount:2},x.clock);input=new ADCInput(c,n=>s.clock.sync.nearestClock(n),n=>Number(n)/1e6,resolve);await s.configure({oidCount:4,commands:c.commands,init:c.init},signal);assert.equal(fw.outputs.at(-1)?.name,'query_analog_in');const next=Number(BigInt.asUintN(32,s.clock.sync.getClock(serialClock.now())));fw.emit('analog_in_state',{oid:3,next_clock:next,values:Buffer.from([0,0,248,127])});const samples=await Promise.race([received,new Promise<never>((_,reject)=>{const t=setTimeout(()=>reject(new Error('ADC report timeout')),2000);t.unref();})]);assert.equal(samples.length,2);assert.equal(samples[1][1],1);const failed=new Promise<void>(resolve=>{const t=setInterval(()=>{if(stops){clearInterval(t);resolve();}},2);setTimeout(()=>{clearInterval(t);resolve();},1000).unref();});fw.emit('analog_in_state',{oid:3,next_clock:next+600000,values:Buffer.from([1])});await failed;assert.equal(stops,1);assert.equal(input.failed,true);
 }finally{await s.stop();await fw.close();}
});
