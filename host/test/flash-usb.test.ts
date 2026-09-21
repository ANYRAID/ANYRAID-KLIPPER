import test from 'node:test';
import assert from 'node:assert/strict';
import {flashUsb,usbFlashTarget,UsbFlashExitError} from '../src/diagnostics/flash-usb.ts';
import {flashRecorder,flashReference} from '../bench/flash-usb-reference.ts';
const signal=()=>new AbortController().signal;
const variants=[['sam3x8e',undefined],['sam4e8e',undefined],['same70q20',undefined],['samd21g18',0x2000],['same54p20',0x4000],['lpc1768',undefined],['stm32f103',0x8000800],['stm32f103',0x8000000],['stm32f407',0x8004000],['stm32f407',0x8000000],['stm32f042',0x8000000],['stm32f070',0x8000000],['stm32f072',0x8000000],['stm32g0b1',0x8000000],['stm32f7',0x8000000],['stm32h7',0x8000000],['stm32l4',0x8000000],['stm32g4',0x8000000],['rp2040',undefined],['rp2350',undefined]] as const;
test('USB flash actions and argument vectors match original Python across every MCU route',async()=>{
 const cases=variants.flatMap(([mcu,start])=>[false,true].flatMap(sudo=>[false,true].map(katapult=>({mcu,start,sudo,katapult,device:'/dev/tty source',image:'/tmp/firmware with space.bin'}))));
 cases.push(...variants.filter(([mcu])=>!mcu.startsWith('sam')).map(([mcu,start])=>({mcu,start,sudo:true,katapult:false,device:mcu==='rp2350'?'2E8A:000F':mcu==='rp2040'?'2e8a:0003':' 0483:DF11 ',image:'/tmp/firmware.bin'})));
 const reference=flashReference(cases);for(const [i,c] of cases.entries()){const recorded=flashRecorder(c.katapult);await flashUsb(c,recorded.io,signal());assert.deepEqual(recorded.events,reference.results[i].events,JSON.stringify(c));}
});
test('USB writes never retry or fall back after failure; only bossac reset exit is tolerated',async()=>{
 for(const mcu of ['sam3','sam4','samd','lpc176','stm32f103','rp2040']){
  const record=flashRecorder();let calls=0;record.io.run=async()=>{calls++;throw new UsbFlashExitError('writer',1);};await assert.rejects(flashUsb({mcu,start:0x8000000,device:'/dev/ttyMock',image:'/tmp/image'},record.io,signal()),/writer/);assert.equal(calls,1);
 }
 for(const resetError of [new UsbFlashExitError('reset',1),new Error('spawn failed')]){const record=flashRecorder();let calls=0;record.io.run=async()=>{if(++calls===2)throw resetError;};const work=flashUsb({mcu:'sam4',device:'/dev/ttyMock',image:'/tmp/image'},record.io,signal());if(resetError instanceof UsbFlashExitError)await work;else await assert.rejects(work,/spawn failed/);assert.equal(calls,2);}
});
test('USB cancellation prevents subsequent actions and invalid options perform no I/O',async()=>{
 const record=flashRecorder(),controller=new AbortController();record.io.enterBootloader=async()=>{controller.abort(new Error('cancel boot'));};await assert.rejects(flashUsb({mcu:'sam3',device:'/dev/ttyMock',image:'/tmp/image'},record.io,controller.signal),/cancel boot/);assert.deepEqual(record.events,[['serial','/dev/ttyMock']]);
 for(const change of [{mcu:'unknown'},{image:'-erase'},{device:''},{device:'x\0y'},{mcu:'samd'},{start:-1},{sudo:1}])assert.throws(()=>usbFlashTarget({mcu:'sam3',device:'/dev/ttyMock',image:'/tmp/image',...change} as Parameters<typeof usbFlashTarget>[0]));
});
