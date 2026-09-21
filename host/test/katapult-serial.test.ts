import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {katapultFrame,flashKatapult} from '../src/diagnostics/katapult.ts';
import {openKatapultSerial,katapultNeedsPriming} from '../src/diagnostics/katapult-serial.ts';
import {katapultPTY} from './helpers/katapult-pty.ts';
const signal=()=>new AbortController().signal;
test('real PTY Katapult completes primed, fragmented upload and readback including embedded trailer bytes',async()=>{
 const peer=katapultPTY({prime:true,fragment:true}),transport=openKatapultSerial(peer.path,{prime:true},signal());
 try{const image=Buffer.alloc(513);for(let i=0;i<image.length;i++)image[i]=i%2?3:0x99;const result=await flashKatapult(image,transport,signal(),{expectedMcu:'stm32f407'});assert.equal(result.blocks,3);assert.equal(peer.commands[0],0x90);assert.equal(peer.commands.filter(c=>c===0x90).length,1);assert.equal(peer.commands.at(-1),0x15);assert.equal(peer.sim.memory.size,3);}finally{transport.close();await peer.close();}
 for(const [name,expected] of [['stm32f103',true],['stm32g0b1',true],['stm32f407',false],['stm32f207',false],['stm32h743',false],['rp2040',false]] as const)assert.equal(katapultNeedsPriming(name),expected);
});
test('Katapult timeout, corrupt reply and cancellation close UART without retry and release lock',async()=>{
 for(const mode of ['timeout','crc','cancel','close']){
  const peer=katapultPTY({silent:mode!=='crc',corrupt:mode==='crc'}),controller=new AbortController(),transport=openKatapultSerial(peer.path,{},signal());
  try{const pending=transport.exchange(katapultFrame(0x11),mode==='timeout'?40:1000,controller.signal);const rejected=assert.rejects(pending,mode==='timeout'?/timed out/:mode==='crc'?/CRC/:mode==='cancel'?/cancel/:/closed/);if(mode==='cancel'||mode==='close'){await delay(10);if(mode==='cancel')controller.abort(new Error('cancel'));else transport.close();}await rejected;assert.equal(peer.commands.length,1);await assert.rejects(transport.exchange(katapultFrame(0x11),100,signal()),/closed/);const reopened=openKatapultSerial(peer.path,{},signal());reopened.close();}finally{transport.close();await peer.close();}
 }
});
test('Katapult rejects overlapping exchange and pre-abort without replay',async()=>{
 const peer=katapultPTY({silent:true}),controller=new AbortController(),transport=openKatapultSerial(peer.path,{},signal());
 try{const first=transport.exchange(katapultFrame(0x11),1000,controller.signal),rejected=assert.rejects(first);await assert.rejects(transport.exchange(katapultFrame(0x11),100,signal()),/Concurrent/);controller.abort();await rejected;assert.throws(()=>openKatapultSerial(peer.path,{},AbortSignal.abort(new Error('preabort'))),/preabort/);}finally{transport.close();await peer.close();}
});
