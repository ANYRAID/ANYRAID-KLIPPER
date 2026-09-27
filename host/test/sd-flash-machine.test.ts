import test from 'node:test';
import assert from 'node:assert/strict';
import {compileSDFlashBoard,openSDFlashMachine} from '../src/diagnostics/sd-flash-machine.ts';
import {uploadSDFirmware} from '../src/diagnostics/sd-upload.ts';
import {SDCardEmulator} from './helpers/sd-card-spi.ts';
import {fatDisk} from './helpers/fatfs-disk.ts';
import {sdCRC7} from '../src/diagnostics/sd-card-spi.ts';
import {serialFirmware} from './helpers/serial-firmware.ts';
import {SerialSession} from '../src/protocol/serial-session.ts';
const signal=()=>new AbortController().signal;
async function fixture(mcu='stm32f103xe',pins='PA6,PA7,PA8',legacySpiConfig=false){
 const image=fatDisk(),card=new SDCardEmulator();card.image=image.image;card.csd[9]=7;card.csd[15]=sdCRC7(card.csd.subarray(0,15));let stops=0;
 const firmware=await serialFirmware(undefined,{mcu,legacySpiConfig,extendedPins:true,spiPins:pins,tmcSpi(_oid,data,read){if(read)return {data:card.transferBytes(data,signal())};card.sendBytes(data,signal());return {data:new Uint8Array()};}}),session=new SerialSession(firmware.fd,{async stopDevice(){stops++;}});
 await session.initialize(signal());return {firmware,session,card,get stops(){return stops;},async close(){await session.stop();await firmware.close();}};
}
for(const legacy of [false,true])test(`board factory uploads over native SPI with ${legacy?'legacy':'modern'} chip select`,async t=>{
 const f=await fixture('stm32f103xe','PA6,PA7,PA8',legacy);try{const start=performance.now(),machine=await openSDFlashMachine(f.session,'btt-skr-mini-e3-v2',signal());try{
  assert.equal(machine.plan.mcu,'stm32f103xe');assert.equal(f.session.configuration.reused,false);
  const receipt=await uploadSDFirmware(machine.files,machine.plan.name,machine.plan.mcu,Buffer.alloc(4097,23),signal());assert.equal(receipt.state,'uploaded');assert.equal(receipt.activationVerified,false);assert.equal(receipt.path,'firmware.bin');
  await assert.rejects(openSDFlashMachine(f.session,'btt-skr-mini',signal()),/fresh exclusive/);t.diagnostic(JSON.stringify({bytes:4097,configureMountUploadVerifyMs:performance.now()-start,scope:'Board factory, native simulated UART/SPI and FAT16 image; excludes physical hardware'}));
 }finally{await machine.close();}assert.equal(f.stops,1);assert.equal(f.session.status.state,'closed');}finally{await f.close();}
});
test('MCU mismatch and chip-select overlap fail before configuration or card commands',async()=>{
 for(const [mcu,pins] of [['stm32f401xc','PA6,PA7,PA8'],['stm32f103xe','PA4,PA7,PA8']]){const f=await fixture(mcu,pins);try{assert.throws(()=>compileSDFlashBoard(f.session,f.session.dictionary,'btt-skr-mini'));assert.equal(f.card.commands.length,0);assert.equal(f.session.status.configured,false);}finally{await f.close();}}
});
test('existing MCU configuration is not reused or reset for SD flashing',async()=>{
 const f=await fixture();try{await f.session.configure({oidCount:0,commands:[]},signal());await assert.rejects(openSDFlashMachine(f.session,'btt-skr-mini',signal()),/fresh exclusive/);assert.equal(f.card.commands.length,0);assert.equal(f.stops,0);}finally{await f.close();}
});
test('software SPI board preflight selects modern and legacy commands and rejects reserved pins',async()=>{
 const {MessageDictionary}=await import('../src/protocol/dictionary.ts'),{spiFormats,softwareSpiFormats}=await import('../src/protocol/spi-config.ts');
 for(const modern of [true,false])for(const reserved of [false,true]){
  const d=new MessageDictionary();d.identify(Buffer.from(JSON.stringify({commands:{[spiFormats.config]:2,[spiFormats.send]:3,[spiFormats.transfer]:4,[softwareSpiFormats[modern?'modern':'legacy']]:5},responses:{[spiFormats.response]:6},enumerations:{pin:{PA4:4,PA5:5,PA6:6,PB5:21}},config:{MCU:'stm32f407xx',CLOCK_FREQ:168000000,...reserved?{RESERVE_PINS_probe:'PA6'}:{}}})),false);
  if(reserved){assert.throws(()=>compileSDFlashBoard({},d,'btt-skr-pro',true),/reserved/i);continue;}
  const compiled=compileSDFlashBoard({},d,'btt-skr-pro',true);assert.equal(compiled.configuration.firmwareRestart,true);assert.equal(compiled.configuration.commands[0],'config_spi oid=0 pin=PA4 cs_active_high=0');assert.equal(compiled.configuration.commands[1],modern?'spi_set_sw_bus oid=0 miso_pin=PA6 mosi_pin=PB5 sclk_pin=PA5 mode=0 pulse_ticks=42':'spi_set_software_bus oid=0 miso_pin=PA6 mosi_pin=PB5 sclk_pin=PA5 mode=0 rate=4000000');
 }
});
