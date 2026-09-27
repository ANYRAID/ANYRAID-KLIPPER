import test from 'node:test';
import assert from 'node:assert/strict';
import {compileTmcSoftwareSpi,tmcSpiFormats,tmcSoftwareSpiFormats} from '../src/drivers/tmc-spi-mcu.ts';
import {MessageDictionary} from '../src/protocol/dictionary.ts';
const chip={},pin=(name:string)=>({chip,chipName:'mcu',pin:name,invert:0 as const,pullup:0 as const});
function dictionary(modern:boolean,frequency:number){const d=new MessageDictionary();d.identify(Buffer.from(JSON.stringify({commands:{[tmcSpiFormats.config]:10,[tmcSpiFormats.send]:11,[tmcSpiFormats.transfer]:12,[tmcSoftwareSpiFormats[modern?'modern':'legacy']]:13},responses:{[tmcSpiFormats.response]:14},enumerations:{pin:{PA0:0,PA1:1,PA2:2,PA3:3}},config:{CLOCK_FREQ:frequency}})),false);return d;}
test('software SPI selects actual firmware format without requiring hardware SPI support',()=>{
 for(const modern of [false,true])for(const frequency of [1000000,12000000,72000000,168000000])for(const rate of [100000,999999,4000000]){
  const result=compileTmcSoftwareSpi(chip,dictionary(modern,frequency),1,pin('PA0'),[pin('PA1'),pin('PA2'),pin('PA3')],rate);
  assert.equal(result.configureBus,`${modern?'spi_set_sw_bus':'spi_set_software_bus'} oid=1 miso_pin=PA1 mosi_pin=PA2 sclk_pin=PA3 mode=3 ${modern?'pulse_ticks='+Math.trunc((1/rate)*frequency):'rate='+rate}`);
 }
 // Original MCU.seconds_to_clock truncates; it does not round 13.5 ticks to 14.
 assert.match(compileTmcSoftwareSpi(chip,dictionary(true,1350000),1,pin('PA0'),[pin('PA1'),pin('PA2'),pin('PA3')],100000).configureBus,/pulse_ticks=13$/);
});
test('software SPI rejects foreign chips, polarity, missing pins and invalid clocks before I/O',()=>{
 const d=dictionary(true,72000000),bus=[pin('PA1'),pin('PA2'),pin('PA3')];
 assert.throws(()=>compileTmcSoftwareSpi(chip,d,0,pin('PA0'),bus.slice(1)));
 assert.throws(()=>compileTmcSoftwareSpi(chip,d,0,pin('PA0'),[{...pin('PA1'),chip:{}},...bus.slice(1)]));
 assert.throws(()=>compileTmcSoftwareSpi(chip,d,0,{...pin('PA0'),invert:1},bus));
 assert.throws(()=>compileTmcSoftwareSpi(chip,dictionary(true,0),0,pin('PA0'),bus));
});
