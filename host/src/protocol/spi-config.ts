import type {MessageDictionary} from './dictionary.ts';
import type {PinBinding} from './pins.ts';
export const spiFormats={config:'config_spi oid=%c pin=%u cs_active_high=%c',bus:'spi_set_bus oid=%c spi_bus=%u mode=%u rate=%u',send:'spi_send oid=%c data=%*s',transfer:'spi_transfer oid=%c data=%*s',response:'spi_transfer_response oid=%c response=%*s'} as const;
export const legacySpiConfig='config_spi oid=%c pin=%u';
function chipSelect(d:MessageDictionary,oid:number,pin:string){
 let modern=true;try{d.lookup(spiFormats.config);}catch{d.lookup(legacySpiConfig);modern=false;}
 return `config_spi oid=${oid} pin=${pin}${modern?' cs_active_high=0':''}`;
}
/** Caller owns GPIO reservation and must configure ALL chip selects before
 * applying bus commands. Explicit bus selection avoids silently choosing pins. */
export function compileSpi<T>(chip:T,d:MessageDictionary,oid:number,cs:PinBinding<T>,bus:string|number,rate=4000000,mode=3){
 if(!Number.isInteger(mode)||mode<0||mode>3)throw new RangeError('Invalid SPI mode');
 if(!Number.isInteger(oid)||oid<0||oid>254||cs.chip!==chip||!cs.pin||/[\s^~!:]/u.test(cs.pin)||cs.invert!==0||cs.pullup!==0||!Number.isInteger(rate)||rate<100000||rate>0xffffffff||typeof bus==='number'&&(!Number.isInteger(bus)||bus<0||bus>0xffffffff)||typeof bus==='string'&&(!bus||/[\s=]/u.test(bus)))throw new Error('Invalid SPI configuration');
 for(const key of ['bus','send','transfer','response'] as const)d.lookup(spiFormats[key]);
 const select=chipSelect(d,oid,cs.pin),configureBus=`spi_set_bus oid=${oid} spi_bus=${bus} mode=${mode} rate=${rate}`;d.encodeCommand(select);d.encodeCommand(configureBus);
 return Object.freeze({oid,rate,select,configureBus});
}
export const softwareSpiFormats={modern:'spi_set_sw_bus oid=%c miso_pin=%u mosi_pin=%u sclk_pin=%u mode=%u pulse_ticks=%u',legacy:'spi_set_software_bus oid=%c miso_pin=%u mosi_pin=%u sclk_pin=%u mode=%u rate=%u'} as const;
export function compileSoftwareSpi<T>(chip:T,d:MessageDictionary,oid:number,cs:PinBinding<T>,bus:readonly PinBinding<T>[],rate=4000000,mode=3){
 if(!Number.isInteger(mode)||mode<0||mode>3)throw new RangeError('Invalid SPI mode');
 if(!Number.isInteger(oid)||oid<0||oid>254||!Number.isInteger(rate)||rate<100000||rate>0xffffffff||bus.length!==3||[cs,...bus].some(p=>p.chip!==chip||!p.pin||/[\s^~!:]/u.test(p.pin)||p.invert!==0||p.pullup!==0))throw new Error('Invalid software SPI configuration');
 for(const key of ['send','transfer','response'] as const)d.lookup(spiFormats[key]);
 let modern=true;try{d.lookup(softwareSpiFormats.modern);}catch{modern=false;d.lookup(softwareSpiFormats.legacy);}
 const frequency=Number(d.constant('CLOCK_FREQ')),pulseTicks=Math.trunc((1/rate)*frequency);
 if(!Number.isFinite(frequency)||frequency<=0||frequency>1e9||pulseTicks<0||pulseTicks>0xffffffff)throw new RangeError('Invalid software SPI clock');
 const select=chipSelect(d,oid,cs.pin),configureBus=`${modern?'spi_set_sw_bus':'spi_set_software_bus'} oid=${oid} miso_pin=${bus[0].pin} mosi_pin=${bus[1].pin} sclk_pin=${bus[2].pin} mode=${mode} ${modern?'pulse_ticks='+pulseTicks:'rate='+rate}`;d.encodeCommand(select);d.encodeCommand(configureBus);
 return Object.freeze({oid,rate,select,configureBus});
}
