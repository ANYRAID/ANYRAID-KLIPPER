import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {sdFlashBoards,sdBoardDefinition,planSDFlash,prepareSDFirmware} from '../src/diagnostics/sd-boards.ts';
import {encodeRobin,encodeChitu} from '../src/build/firmware.ts';
test('all SD flash boards and aliases preserve frozen original Python definitions',()=>{
 const reference=JSON.parse(readFileSync(new URL('../contracts/sd-boards-reference.json',import.meta.url),'utf8'));assert.deepEqual(sdFlashBoards,[...new Set(reference.legacyList)].sort());
 for(const [name,expected] of Object.entries(reference.resolved)){assert.deepEqual(sdBoardDefinition(name.toUpperCase()),expected);const b=sdBoardDefinition(name),plan=planSDFlash(name,b.mcu);assert.equal(plan.mcu,b.mcu);assert.equal(plan.requiresPowerCycle,b.skip_verify??false);b.mcu='mutated';assert.notEqual(sdBoardDefinition(name).mcu,'mutated');}
 for(const name of ['__proto__','constructor','unknown',' btt-skr-mini'])assert.throws(()=>sdBoardDefinition(name));assert.throws(()=>planSDFlash('btt-skr-mini','stm32f401xc'),/mismatch/);
 assert.deepEqual(planSDFlash('btt-octopus-f407-v1','stm32f407xx',true).bus,{kind:'software-spi',pins:['PC8','PD2','PC12'],chipSelect:'PC11',rate:4000000,mode:0});
});
test('SD firmware preparation uses in-process converters, exact names and converted hash',()=>{
 const input=Buffer.from(Array.from({length:65537},(_,i)=>i&255));
 for(const [name,mcu,convert] of [['btt-skr-mini','stm32f103xe',(b:Uint8Array)=>Buffer.from(b)],['mks-robin-e3','stm32f103xe',encodeRobin],['chitu-v6','stm32f103xe',(b:Uint8Array)=>encodeChitu(b).firmware]] as const){const prepared=prepareSDFirmware(name,mcu,input);assert.deepEqual(prepared.bytes,convert(input));assert.equal(prepared.sha256,createHash('sha256').update(prepared.bytes).digest('hex'));assert.equal(prepared.size,prepared.bytes.length);}
 assert.equal(prepareSDFirmware('mks-robin-e3d','stm32f103xe',input).path,'Robin_e3.bin');assert.throws(()=>prepareSDFirmware('creality-v4.2.7','stm32f103xe',input),/timestamp/);assert.equal(prepareSDFirmware('creality-v4.2.7','stm32f103xe',input,{timestamp:'20260928010101'}).path,'20260928010101firmware.bin');
 assert.throws(()=>prepareSDFirmware('btt-skr-mini','stm32f103xe',new Uint8Array()));assert.throws(()=>prepareSDFirmware('btt-skr-mini','stm32f103xe',input,{timestamp:'20260928010101'}));
});
