import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {Tmc220xMonitor} from '../src/drivers/tmc220x-monitor.ts';import {tmc2240Temperature} from '../src/drivers/tmc2240-temperature.ts';import {tmc220xStatusReader} from '../src/drivers/tmc220x-status.ts';import {FakeClock} from './helpers/clock-scheduler.ts';
const signal=()=>new AbortController().signal;
test('all 8192 temperature ADC values match original Python rounded status exactly',()=>{
 const {values}=JSON.parse(readFileSync(new URL('../contracts/tmc2240-temperature-reference.json',import.meta.url),'utf8')) as {values:number[]};assert.equal(values.length,8192);values.forEach((value,raw)=>assert.equal(tmc2240Temperature(raw),value));for(const raw of [-1,.5,8192,NaN,Infinity])assert.throws(()=>tmc2240Temperature(raw));
});
test('2240 clears startup flags, samples temperature periodically and tolerates temperature-only read errors',async()=>{
 const clock=new FakeClock(),faults:unknown[]=[],writes:number[]=[],reads:number[]=[];let gstat=0x19,adc=2808,fail=false;
 const monitor=new Tmc220xMonitor({async read(reg){reads.push(reg);if(reg===1)return gstat;if(reg===0x51){if(fail)throw Error('temperature unavailable');return adc;}return (1<<26)|(1<<14);},async write(reg,value){assert.equal(reg,1);writes.push(value);gstat=0;}},e=>faults.push(e),clock,{model:'tmc2240',currentActive:()=>true});
 const status=tmc220xStatusReader({model:'tmc2240',current:{runCurrent:.8,holdCurrent:.3}},monitor);
 await monitor.start(signal());assert.deepEqual(writes,[0x19]);assert.equal(status().temperature,null);assert(!reads.includes(0x51));await clock.advance(1.1);assert.equal(status().temperature,100);assert.deepEqual(status().drv_status,{stealth:1,otpw:1});assert.equal(monitor.status.warnings,1<<26);
 const before=reads.length;status();status();assert.equal(reads.length,before);fail=true;await clock.advance(1.1);assert.equal(status().temperature,null);assert.equal(status().native_monitor.active,true);assert.equal(faults.length,0);fail=false;adc=2038;await clock.advance(1.1);assert.equal(status().temperature,0);
 adc=8192;await clock.advance(1.1);assert.equal(status().temperature,null);await monitor.stop();assert.equal(status().temperature,null);assert.equal(clock.pending,0);
});
test('2240 confirms every motor fault and GSTAT bit before stopping without runtime clearing',async()=>{
 for(const [register,bit] of [[0x6f,1<<12],[0x6f,1<<13],[0x6f,1<<25],[0x6f,1<<27],[0x6f,1<<28],...[0,1,2,3,4].map(i=>[1,1<<i])]){
  const clock=new FakeClock(),faults:unknown[]=[];let active=false,hits=0;
  const monitor=new Tmc220xMonitor({async read(reg){if(active&&reg===register){hits++;return bit;}return reg===0x51?2038:0;},async write(){assert.fail('runtime must not clear faults');}},e=>faults.push(e),clock,{model:'tmc2240',currentActive:()=>true});
  await monitor.start(signal());active=true;await clock.advance(1.1);assert.equal(hits,3);assert.equal(faults.length,1);assert(monitor.status.closed);assert.equal(monitor.status.temperature,null);await monitor.stop();
 }
});
test('temperature sampling cancellation is joined and never swallowed as a communication warning',async()=>{
 const clock=new FakeClock();let joined=false;
 const monitor=new Tmc220xMonitor({async read(reg,s){if(reg!==0x51)return 0;return new Promise<number>((_,reject)=>s.addEventListener('abort',()=>{joined=true;reject(s.reason);},{once:true}));},async write(){}},()=>assert.fail('normal close'),clock,{model:'tmc2240',currentActive:()=>false});
 await monitor.start(signal());await clock.advance(1);await monitor.stop();assert(joined);assert(monitor.status.closed);assert.equal(clock.pending,0);assert.equal(monitor.status.temperature,null);
});
