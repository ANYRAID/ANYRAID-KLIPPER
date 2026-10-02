import test from 'node:test';
import assert from 'node:assert/strict';
import {MessageDictionary} from '../src/protocol/dictionary.ts';
import {EndstopProtocol,endstopFormats} from '../src/inputs/endstop.ts';
const chip={};
function fixture(invert:0|1=0,pullup:-1|0|1=1){
 const dictionary=new MessageDictionary();dictionary.identify(Buffer.from(JSON.stringify({commands:{[endstopFormats.config]:2,[endstopFormats.home]:3,[endstopFormats.query]:4},responses:{[endstopFormats.state]:5},config:{CLOCK_FREQ:12000000},enumerations:{pin:{PA1:17}}})),false);
 return {dictionary,endstop:new EndstopProtocol(chip,dictionary,7,{chip,chipName:'mcu',pin:'PA1',invert,pullup})};
}
const options={printTime:2,sampleTime:.000015,sampleCount:4,restTime:.001,trsyncOid:8};
test('endstop configuration, pull-down, restart and wire command preserve firmware contract',()=>{
 const {dictionary,endstop}=fixture(1,-1);
 assert.deepEqual(endstop.commands,['config_endstop oid=7 pin=PA1 pull_up=-1']);
 assert.doesNotThrow(()=>dictionary.encodeCommand(endstop.commands[0]));
 assert.deepEqual(endstop.stop(),dictionary.encodeCommand(endstop.restart[0]));
 assert.deepEqual(endstop.query(),dictionary.encode('endstop_query_state',{oid:7}));
 const plan=endstop.home(options,t=>BigInt(Math.trunc(t*12000000)));
 assert.equal(plan.reqClock,24000000n);assert.equal(plan.restTicks,12000n);
 assert.deepEqual(plan.payload,dictionary.encode('endstop_home',{oid:7,clock:24000000,sample_ticks:180,sample_count:4,rest_ticks:12000,pin_value:0,trsync_oid:8,trigger_reason:1}));
});
test('endstop preserves extended clocks and derives rest ticks from mapped endpoints',()=>{
 const {endstop}=fixture();const base=1n<<54n;
 const plan=endstop.home(options,t=>base+BigInt(Math.trunc(t*12000001.5)));
 assert.equal(plan.reqClock,base+24000003n);assert.equal(plan.restTicks,12000n);
 const state=endstop.decode({name:'endstop_state',parameters:{oid:7,homing:0,pin_value:0,next_clock:12005}})!;
 assert.equal(state.triggered,false);
 assert.equal(endstop.hitClock(state,plan,()=>plan.reqClock+12005n),plan.reqClock+5n);
 assert.throws(()=>endstop.hitClock(state,plan,()=>plan.reqClock+11999n),/predates/);
});
test('endstop validates polarity, routing and response widths',()=>{
 for(const invert of [0,1] as const){const {endstop}=fixture(invert);
  assert.equal(endstop.decode({name:'other',parameters:{}}),undefined);
  assert.equal(endstop.decode({name:'endstop_state',parameters:{oid:8}}),undefined);
  for(const pin of [0,1])assert.equal(endstop.decode({name:'endstop_state',parameters:{oid:7,homing:1,pin_value:pin,next_clock:0xffffffff}})!.triggered,!!(pin^invert));
  for(const patch of [{homing:2},{pin_value:-1},{next_clock:2**32},{next_clock:NaN}])assert.throws(()=>endstop.decode({name:'endstop_state',parameters:{oid:7,homing:0,pin_value:1,next_clock:1,...patch}}));
 }
});
test('endstop rejects invalid scheduling before producing commands',()=>{
 const {endstop}=fixture();const map=(t:number)=>BigInt(Math.trunc(t*12000000));
 for(const patch of [{printTime:NaN},{printTime:-1},{printTime:1e20},{sampleTime:0},{sampleTime:1e-12},{sampleTime:200},{sampleCount:0},{sampleCount:256},{restTime:0},{restTime:200},{trsyncOid:7},{trsyncOid:255}])assert.throws(()=>endstop.home({...options,...patch},map));
 for(const map of [()=>-1n,()=>1n<<63n,()=>0n])assert.throws(()=>endstop.home(options,map));
 const {dictionary}=fixture();assert.throws(()=>new EndstopProtocol({},dictionary,7,{chip,chipName:'mcu',pin:'PA1',invert:0,pullup:1}));
});
