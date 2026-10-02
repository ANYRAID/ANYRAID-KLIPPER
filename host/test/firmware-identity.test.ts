import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {findFirmwareIdentity,flashKatapultFirmware} from '../src/diagnostics/firmware-identity.ts';
import {firmwareIdentityReference} from '../bench/firmware-identity-reference.ts';
import {katapultSimulator} from '../bench/katapult-reference.ts';
const signal=()=>new AbortController().signal;
const dict=(mcu='stm32f407')=>deflateSync(JSON.stringify({app:'Klipper',version:'v-test',config:{MCU:mcu}}));
test('embedded dictionary discovery matches frozen original Python including offsets and compressed streams followed by binary data',async()=>{
 for(const prefix of [0,1,257,65537]){const image=Buffer.concat([Buffer.alloc(prefix,0xff),dict(),Buffer.alloc(51,0xaa)]),found=await findFirmwareIdentity(image,signal()),reference=firmwareIdentityReference(image);assert.deepEqual(found,{offset:prefix,...reference.identity});}
 const noDictionary=Buffer.alloc(4096,0xff);assert.equal(await findFirmwareIdentity(noDictionary,signal()),undefined);assert.equal(firmwareIdentityReference(noDictionary).identity,null);
});
test('firmware scan rejects bombs and candidate floods, skips non-Klipper JSON, supports cancellation',async()=>{
 const nonKlipper=deflateSync(JSON.stringify({app:'Other',config:{MCU:'wrong'}})),good=dict();assert.equal(await findFirmwareIdentity(nonKlipper,signal()),undefined);assert.equal((await findFirmwareIdentity(Buffer.concat([nonKlipper,good]),signal()))?.mcu,'stm32f407');
 await assert.rejects(findFirmwareIdentity(deflateSync(Buffer.alloc(4*1024*1024+1)),signal()),/decompression limit/);
 await assert.rejects(findFirmwareIdentity(Buffer.from('789c'.repeat(4100),'hex'),signal()),/candidate limit/);
 await assert.rejects(findFirmwareIdentity(deflateSync('{"app":"Klipper","config":{"MCU":42}}'),signal()),/identity/);
 const controller=new AbortController(),pending=findFirmwareIdentity(Buffer.alloc(1024*1024,0xff),controller.signal);controller.abort();await assert.rejects(pending);
});
test('dictionary MCU gates writes and immutable snapshot is used through complete programming',async()=>{
 const bad=katapultSimulator();await assert.rejects(flashKatapultFirmware(dict('other'),bad.transport,signal()),/MCU/);assert.deepEqual(bad.frames.map(f=>f[2]),[0x11]);
 const conflict=katapultSimulator();await assert.rejects(flashKatapultFirmware(dict(),conflict.transport,signal(),{expectedMcu:'other'}),/Requested MCU/);assert.equal(conflict.frames.length,0);
 const image=dict(),original=Buffer.from(image),sim=katapultSimulator(),pending=flashKatapultFirmware(image,sim.transport,signal());image.fill(0);const result=await pending;assert.equal(result.identity?.mcu,'stm32f407');assert.deepEqual(Buffer.concat([...sim.memory.values()]).subarray(0,original.length),original);
});
