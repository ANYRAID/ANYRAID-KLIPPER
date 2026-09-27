import {PrinterPins,type PinBinding,type PinRequest} from '../protocol/pins.ts';
import type {MessageDictionary} from '../protocol/dictionary.ts';
/** Pure pin requests: sharing is scoped to MCU, backend, firmware bus and the
 * complete ordered physical wiring. Mode/rate belong to each chip select and
 * firmware restores them before asserting CS (src/spicmds.c). */
export function spiBusRequests<T>(pins:PrinterPins<T>,mcu:string,dictionary:MessageDictionary,bus:string,software?:readonly PinBinding<T>[]):PinRequest[]{
 const enumeration=dictionary.pinEnumeration,resolver=pins.resolver(mcu).clone();
 const descriptions=software?software.map(p=>{if(p.chipName!==mcu||p.chip!==pins.chip(mcu)||p.invert||p.pullup)throw new Error('SPI bus MCU or polarity differs');return p.pin;}):(()=>{const raw=dictionary.constant('BUS_PINS_'+bus);if(typeof raw!=='string')throw new Error('SPI requires firmware bus pin metadata');return raw.split(',').map(p=>p.trim());})();
 if(descriptions.length!==3)throw new Error('SPI requires three bus pins');
 const names=descriptions.map(name=>resolver.resolve([`claim pin=${name}`])[0].slice(10)),ids=names.map((name,i)=>{
  const id=enumeration[name];if(id===undefined)throw new Error('Unknown SPI bus pin');
  if(!software&&enumeration[descriptions[i]]!==id)throw new Error('Hardware SPI pin alias changes physical wiring');return id;
 });
 if(new Set(ids).size!==3)throw new Error('SPI bus pins overlap');
 const backend=software?'software':'hardware:'+Buffer.from(dictionary.encodeCommand(`spi_set_bus oid=0 spi_bus=${bus} mode=0 rate=100000`)).toString('hex');
 const identity=JSON.stringify([mcu,backend,ids]);
 return names.map((name,index)=>({description:mcu+':'+name,options:{shareType:'spi:'+identity+':'+index},strictSharing:true}));
}
