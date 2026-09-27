import test from 'node:test';
import assert from 'node:assert/strict';
import {ButtonInput,buttonFormats,compileButtons} from '../src/inputs/buttons.ts';
import {MessageDictionary} from '../src/protocol/dictionary.ts';
const message=(ack_count:number,state:number[],oid=2)=>({name:'buttons_state',parameters:{oid,ack_count,state:Buffer.from(state)}});
test('buttons overlap, duplicates, inversion and 8-bit acknowledgement wrap preserve transitions',()=>{
 const d=new ButtonInput({oid:2,count:2,invert:2});assert.deepEqual(d.receive(message(0,[3,2])),{ack:2,samples:[{state:1,changed:1},{state:0,changed:1}]});assert.equal(d.receive(message(0,[3,2])),undefined);
 assert.deepEqual(d.receive(message(1,[2,0])),{ack:1,samples:[{state:2,changed:2}]});
 for(let i=3;i<600;i++){const batch=d.receive(message(i&255,[i&3]));assert.equal(batch!.ack,1);assert.equal(batch!.samples[0].state,(i&3)^2);}
 assert.equal(d.status.acknowledged,600n);assert.equal(d.status.failed,false);
});
test('invalid state and forward gaps fail atomically and cannot resume',()=>{
 for(const msg of [message(1,[1]),message(0,[]),message(0,[4]),message(256,[1]),message(0,Array(9).fill(0))]){
  const d=new ButtonInput({oid:2,count:2,invert:0});assert.throws(()=>d.receive(msg));assert.equal(d.status.acknowledged,0n);assert.equal(d.status.state,0);assert.throws(()=>d.receive(message(0,[1])),/faulted/);
 }
 const d=new ButtonInput({oid:2,count:1,invert:0});assert.equal(d.receive(message(0,[1],3)),undefined);assert.equal(d.status.failed,false);
});
test('button configuration uses original MCU polling and retransmit protocol',()=>{
 const d=new MessageDictionary();d.identify(Buffer.from(JSON.stringify({commands:Object.fromEntries(Object.values(buttonFormats).filter(f=>f!==buttonFormats.state).map((f,i)=>[f,i+2])),responses:{[buttonFormats.state]:10},enumerations:{pin:{PA0:0,PA1:1}},config:{CLOCK_FREQ:1e6}})),false);
 const chip={},pins=[{chip,chipName:'mcu',pin:'PA0',invert:1 as const,pullup:1 as const},{chip,chipName:'mcu',pin:'PA1',invert:0 as const,pullup:0 as const}];
 const plan=compileButtons(chip,d,{oid:2,pins,currentPrintTime:1},t=>BigInt(Math.trunc(t*1e6)));assert.equal(plan.initialClock,2020000n);assert.equal(plan.invert,1);assert.equal(plan.commands[0],'config_buttons oid=2 button_count=2');assert.match(plan.init[2],/rest_ticks=2000 retransmit_count=50 invert=1$/);
 assert.throws(()=>compileButtons(chip,d,{oid:2,pins:[pins[0],pins[0]],currentPrintTime:1},()=>0n),/pin batch/);
});
