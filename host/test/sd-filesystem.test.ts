import test from 'node:test';
import assert from 'node:assert/strict';
import {SDFileSystem} from '../src/diagnostics/sd-filesystem.ts';
import {SDCardSPI,sdCRC7} from '../src/diagnostics/sd-card-spi.ts';
import {SDCardEmulator} from './helpers/sd-card-spi.ts';
import {fatDisk,fat32Disk} from './helpers/fatfs-disk.ts';
const signal=()=>new AbortController().signal;
for(const kind of ['FAT16','FAT32'])test(`${kind} firmware file traverses isolated FatFs and actual SPI card protocol`,async t=>{
 const disk=kind==='FAT32'?fat32Disk():fatDisk(),io=new SDCardEmulator();io.image=disk.image;const size=disk.device.sectors/1024-1;io.csd[7]=(size>>>16)&63;io.csd[8]=(size>>>8)&255;io.csd[9]=size&255;io.csd[15]=sdCRC7(io.csd.subarray(0,15));
 const card=new SDCardSPI(io);let fs=await SDFileSystem.open(card,signal());try{
  await assert.rejects(SDFileSystem.open(card,signal()),/owner/);const bytes=Buffer.from(Array.from({length:16385},(_,i)=>(i*73)&255)),start=performance.now();
  await fs.writeFile('firmware update.bin',bytes,signal());assert.equal((await fs.stat('firmware update.bin',signal())).size,bytes.length);
  const writeMs=performance.now()-start;await fs.close();assert.equal(card.info,undefined);fs=await SDFileSystem.open(card,signal());assert.deepEqual(await fs.readFile('firmware update.bin',signal()),bytes);
  await fs.remove('firmware update.bin',signal());assert(io.writes.length>0);assert(io.commands.some(c=>c.command===17));assert(io.commands.some(c=>c.command===24));
  t.diagnostic(JSON.stringify({filesystem:kind,bytes:bytes.length,writeMs,scope:'File write/stat, isolated native FatFs IPC, SPI command and CRC processing, memory card; no native UART or physical card latency'}));
 }finally{await fs.close();}
});
test('failed filesystem mount releases card initialization and exclusive owner',async()=>{
 const io=new SDCardEmulator(),card=new SDCardSPI(io);await assert.rejects(SDFileSystem.open(card,signal()));assert.equal(card.info,undefined);await assert.rejects(SDFileSystem.open(card,signal()),e=>!String(e).includes('owner'));assert.equal(card.info,undefined);
});
test('FAT32 firmware roundtrip includes native UART, MCU SPI FIFO and remount',async t=>{
 const {SerialSession}=await import('../src/protocol/serial-session.ts'),{serialFirmware}=await import('./helpers/serial-firmware.ts'),{compileSpi}=await import('../src/protocol/spi-config.ts'),{sessionSDCardSPI}=await import('../src/diagnostics/sd-card-mcu.ts');
 const disk=fat32Disk(),io=new SDCardEmulator();io.image=disk.image;io.csd[9]=127;io.csd[15]=sdCRC7(io.csd.subarray(0,15));
 const firmware=await serialFirmware(undefined,{tmcSpi(oid,data,read){assert.equal(oid,0);if(read)return {data:io.transferBytes(data,signal())};io.sendBytes(data,signal());return {data:new Uint8Array()};}}),session=new SerialSession(firmware.fd,{async stopDevice(){}});let fs:SDFileSystem|undefined;
 try{
  await session.initialize(signal());const plan=compileSpi(session,session.dictionary,0,{chip:session,chipName:'mcu',pin:'PA0',invert:0,pullup:0},'spi1',400000,0);await session.configure({oidCount:1,commands:[plan.select,plan.configureBus]},signal());const card=sessionSDCardSPI(session,0);
  fs=await SDFileSystem.open(card,signal());const bytes=Buffer.from(Array.from({length:4097},(_,i)=>i&255)),start=performance.now();await fs.writeFile('firmware.bin',bytes,signal());await fs.close();fs=await SDFileSystem.open(card,signal());assert.deepEqual(await fs.readFile('firmware.bin',signal()),bytes);
  t.diagnostic(JSON.stringify({bytes:bytes.length,writeRemountReadMs:performance.now()-start,scope:'FAT32 helper, SD CRC/commands, native UART and MCU FIFO; simulated firmware/card'}));
 }finally{try{await fs?.close();}finally{await session.stop();await firmware.close();}}
});
test('converted firmware upload verifies on-disk bytes and fences timestamp collisions',async()=>{
 const {uploadSDFirmware}=await import('../src/diagnostics/sd-upload.ts'),{encodeRobin}=await import('../src/build/firmware.ts');const disk=fatDisk(),io=new SDCardEmulator();io.image=disk.image;io.csd[9]=7;io.csd[15]=sdCRC7(io.csd.subarray(0,15));const card=new SDCardSPI(io),fs=await SDFileSystem.open(card,signal());
 try{
  const source=Buffer.alloc(4097,23),receipt=await uploadSDFirmware(fs,'mks-robin-e3','stm32f103xe',source,signal());assert.equal(receipt.activationVerified,false);assert.equal(receipt.path,'Robin_e3.bin');assert.deepEqual(await fs.readFile(receipt.path,signal()),encodeRobin(source));
  const options={timestamp:'20260928010101'};const pending=uploadSDFirmware(fs,'creality-v4.2.7','stm32f103xe',source,signal(),options);await assert.rejects(uploadSDFirmware(fs,'creality-v4.2.7','stm32f103xe',source,signal(),options),/already active/);await pending;await assert.rejects(uploadSDFirmware(fs,'creality-v4.2.7','stm32f103xe',source,signal(),options),/already exists/);const writes=io.writes.length;await assert.rejects(uploadSDFirmware(fs,'creality-v4.2.7','stm32f103xe',source,signal(),options),/already exists/);assert.equal(io.writes.length,writes);
  await assert.rejects(uploadSDFirmware({stat:fs.stat.bind(fs),writeFile:fs.writeFile.bind(fs),async readFile(path,s){const bytes=await fs.readFile(path,s);bytes[0]^=1;return bytes;}},'btt-skr-mini','stm32f103xe',source,signal()),/SHA-256 mismatch/);
 }finally{await fs.close();}
});
