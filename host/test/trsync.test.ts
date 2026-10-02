import test from 'node:test';
import assert from 'node:assert/strict';
import {MessageDictionary} from '../src/protocol/dictionary.ts';
import {TriggerSyncProtocol,trsyncFormats,triggerReason} from '../src/inputs/trsync.ts';
import {encodeFrame} from '../src/protocol/codec.ts';
function fixture(){const dictionary=new MessageDictionary();dictionary.identify(Buffer.from(JSON.stringify({commands:{[trsyncFormats.config]:2,[trsyncFormats.start]:3,[trsyncFormats.timeout]:4,[trsyncFormats.trigger]:5,[trsyncFormats.stepper]:6},responses:{[trsyncFormats.state]:-7},config:{CLOCK_FREQ:12000000}})),false);return {dictionary,protocol:new TriggerSyncProtocol(dictionary,7)};}
test('trsync start binds all coupled steppers before timeout with original clock scheduling',()=>{
 const {dictionary,protocol}=fixture(),start=2n**40n+99n,plan=protocol.start(start,[1,2],.025,.5);
 assert.equal(plan.expireTicks,300000n);assert.equal(plan.reportTicks,90000);assert.equal(plan.minExtendTicks,72000n);assert.equal(plan.reportClock,start+45000n);
 assert.equal(protocol.tags.state,(-7)>>>0);
 assert.deepEqual(plan.packets.map(p=>p.req),[start,0n,0n,start]);
 assert.deepEqual(plan.packets.map(p=>{const m=dictionary.parseFrame(encodeFrame(0,p.data))[0];return {...m,parameters:{...m.parameters}};}),[
  {name:'trsync_start',parameters:{oid:7,report_clock:45099,report_ticks:90000,expire_reason:4}},
  {name:'stepper_stop_on_trigger',parameters:{oid:1,trsync_oid:7}},
  {name:'stepper_stop_on_trigger',parameters:{oid:2,trsync_oid:7}},
  {name:'trsync_set_timeout',parameters:{oid:7,clock:300099}},
 ]);
 assert.deepEqual(protocol.commands,['config_trsync oid=7']);
 assert.deepEqual({...dictionary.parseFrame(encodeFrame(0,dictionary.encodeCommand(protocol.restart[0])))[0].parameters},{oid:7,report_clock:0,report_ticks:0,expire_reason:0});
 assert.doesNotThrow(()=>protocol.start(1n<<54n,[1],.25));
});
test('trsync validates the entire plan and firmware shape before any caller can send it',()=>{
 const {protocol}=fixture();
 for(const ids of [[],[7],[1,1],[-1],[255],[NaN]])assert.throws(()=>protocol.start(1n,ids,.25));
 for(const timeout of [0,-1,NaN,Infinity,1e-12,200])assert.throws(()=>protocol.start(1n,[1],timeout));
 for(const offset of [-1,1,NaN])assert.throws(()=>protocol.start(1n,[1],.25,offset));
 for(const start of [-1n,(1n<<63n)-1n])assert.throws(()=>protocol.start(start,[1],.25));
 for(const reason of [0,256,-1,1.5])assert.throws(()=>protocol.trigger(reason));
 assert.throws(()=>new TriggerSyncProtocol(new MessageDictionary(),7));
});
test('trsync response distinguishes hits, host stop, past end, timeout and reset',()=>{
 const {protocol,dictionary}=fixture();
 const message=(can_trigger:number,trigger_reason:number)=>({name:'trsync_state',parameters:{oid:7,can_trigger,trigger_reason,clock:0xffffffff}});
 assert.equal(protocol.decode({name:'other',parameters:{}}),undefined);
 assert.equal(protocol.decode({name:'trsync_state',parameters:{oid:8}}),undefined);
 assert.deepEqual(protocol.decode(message(1,0)),{canTrigger:true,reason:0,clock32:0xffffffff,failure:false});
 for(const reason of [0,1,2,3,4,5,255])assert.equal(protocol.decode(message(0,reason))!.failure,reason===0||reason>=4);
 for(const reason of Object.values(triggerReason))assert.deepEqual(protocol.trigger(reason),dictionary.encode('trsync_trigger',{oid:7,reason}));
 assert.throws(()=>protocol.decode(message(1,1)));assert.throws(()=>protocol.decode(message(2,0)));assert.throws(()=>protocol.decode(message(0,256)));
});
