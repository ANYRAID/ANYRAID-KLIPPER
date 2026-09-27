import test from 'node:test';
import assert from 'node:assert/strict';
import {Tmc220xMonitor} from '../src/drivers/tmc220x-monitor.ts';
import {FakeClock,settle} from './helpers/clock-scheduler.ts';
const signal=()=>new AbortController().signal;
test('startup clears latched GSTAT once; warnings remain visible without stopping',async()=>{
 const clock=new FakeClock(),writes:number[]=[],faults:unknown[]=[];let gstat=1;
 const monitor=new Tmc220xMonitor({async read(reg){return reg===1?gstat:0xf01;},async write(reg,value){assert.equal(reg,1);writes.push(value);gstat=0;}},e=>faults.push(e),clock);
 await monitor.start(signal());assert.deepEqual(writes,[1]);assert.equal(monitor.status.warnings,0xf01);await clock.advance(3.1);assert.equal(monitor.status.checks,4);assert.equal(faults.length,0);await monitor.stop();assert.equal(clock.pending,0);
});
test('every fatal status bit and runtime reset stop after three confirmations without clearing',async()=>{
 for(const [reg,bit] of [[0x6f,2],[0x6f,4],[0x6f,8],[0x6f,16],[0x6f,32],[1,1],[1,2],[1,4]]){
  const clock=new FakeClock();let active=false,reads=0,writes=0;const errors:unknown[]=[];
  const monitor=new Tmc220xMonitor({async read(r){if(active&&r===reg){reads++;return bit;}return 0;},async write(){writes++;}},e=>errors.push(e),clock);
  await monitor.start(signal());active=true;await clock.advance(1.1);assert.equal(reads,3);assert.equal(errors.length,1);assert.equal(writes,0);assert.equal(monitor.status.closed,true);await clock.advance(5);assert.equal(errors.length,1);await monitor.stop();
 }
});
test('startup refuses persistent errors, and stop aborts and joins an in-flight read',async()=>{
 const bad=new Tmc220xMonitor({async read(){return 2;},async write(){}},()=>assert.fail());await assert.rejects(bad.start(signal()),/driver fault/);
 const clock=new FakeClock();let block=false,aborted=false;
 const monitor=new Tmc220xMonitor({async read(_r,s){if(!block)return 0;return new Promise<number>((_ok,no)=>s.addEventListener('abort',()=>{aborted=true;no(s.reason);},{once:true}));},async write(){}},()=>assert.fail('normal close is not a runtime fault'),clock);
 await monitor.start(signal());block=true;await clock.advance(1);await settle();await monitor.stop();assert.equal(aborted,true);assert.equal(clock.pending,0);
});
test('TMC2130 status masks, read-cleared GSTAT and active-current reset checks are model-specific',async()=>{
 for(const bit of [1<<25,1<<27,1<<28]){
  const clock=new FakeClock(),faults:unknown[]=[];let status=0,gstat=1;
  const monitor=new Tmc220xMonitor({async read(r){if(r===1){const v=gstat;gstat=0;return v;}return status;},async write(){assert.fail('SPI GSTAT must not be written');}},e=>faults.push(e),clock,{currentActive:()=>false});
  await monitor.start(signal());status=1<<26;await clock.advance(1.1);assert.equal(monitor.status.warnings,1<<26);assert.equal(faults.length,0);status=bit;await clock.advance(1.1);assert.equal(faults.length,1);await monitor.stop();
 }
 const clock=new FakeClock(),faults:unknown[]=[];let active=false;
 const monitor=new Tmc220xMonitor({async read(){return 0;},async write(){assert.fail();}},e=>faults.push(e),clock,{currentActive:()=>active});
 await monitor.start(signal());await clock.advance(1.1);assert.equal(faults.length,0);active=true;await clock.advance(1.1);assert.equal(faults.length,1);await monitor.stop();
});
