// Board data ported from scripts/spi_flash/board_defs.py.
// Eric Callahan (2021), GPL-3.0-or-later.
import catalog from './sd-boards.json' with {type:'json'};
import {createHash} from 'node:crypto';
import {encodeRobin,encodeChitu,maximumFirmwareBytes} from '../build/firmware.ts';
interface LegacyBoard {mcu:string;spi_bus?:string;spi_pins?:string;cs_pin?:string;sdio_bus?:string;conversion_script?:string;firmware_path?:string;current_firmware_path?:string;skip_verify?:boolean;requires_unique_fw_name?:boolean;}
const boards:Readonly<Record<string,LegacyBoard>>=catalog.boards,aliases:Readonly<Record<string,string>>=catalog.aliases;
export const sdFlashBoards:readonly string[]=Object.freeze([...new Set([...Object.keys(boards),...Object.keys(aliases)])].sort());
export function sdBoardDefinition(name:string):LegacyBoard{
 if(typeof name!=='string'||!Object.hasOwn(boards,name.toLowerCase())&&!Object.hasOwn(aliases,name.toLowerCase()))throw new Error('Unknown SD flash board');
 const key=name.toLowerCase(),canonical=Object.hasOwn(aliases,key)?aliases[key]:key;return structuredClone(boards[canonical]);
}
export function planSDFlash(name:string,actualMCU:string,fast=false){
 const b=sdBoardDefinition(name);if(actualMCU!==b.mcu)throw new Error('SD flash board MCU mismatch');if(typeof fast!=='boolean')throw new TypeError('Invalid SPI speed selection');
 const bus=b.sdio_bus?{kind:'sdio' as const,bus:b.sdio_bus}:b.spi_bus==='swspi'?{kind:'software-spi' as const,pins:b.spi_pins!.split(',') as [string,string,string],chipSelect:b.cs_pin!,rate:fast?4000000:400000,mode:0 as const}:{kind:'spi' as const,bus:b.spi_bus!,chipSelect:b.cs_pin!,rate:fast?4000000:400000,mode:0 as const};
 if(bus.kind==='software-spi'&&(bus.pins.length!==3||new Set([...bus.pins,bus.chipSelect]).size!==4))throw new Error('Invalid board software SPI pin map');
 const conversion=b.conversion_script===undefined?'none':b.conversion_script==='scripts/update_mks_robin.mts'?'robin':b.conversion_script==='scripts/update_chitu.mts'?'chitu':undefined;if(!conversion)throw new Error('Unsupported firmware conversion');
 return {name:name.toLowerCase(),mcu:b.mcu,bus,conversion,firmwarePath:b.firmware_path??'firmware.bin',currentFirmwarePath:b.current_firmware_path??'FIRMWARE.CUR',requiresPowerCycle:b.skip_verify??false,requiresUniqueName:b.requires_unique_fw_name??false};
}
/** Pure preparation: no subprocess, file write, device access or restart.
 * A caller choosing a timestamped name must still reject an existing filename. */
export function prepareSDFirmware(name:string,actualMCU:string,input:Uint8Array,options:{fast?:boolean;timestamp?:string}={}){
 if(!(input instanceof Uint8Array)||input.buffer instanceof SharedArrayBuffer||input.length<1||input.length>maximumFirmwareBytes)throw new RangeError('Invalid SD firmware image');
 const plan=planSDFlash(name,actualMCU,options.fast??false);let path=plan.firmwarePath;
 if(plan.requiresUniqueName){if(!options.timestamp||!/^\d{14}$/.test(options.timestamp))throw new Error('Board requires an explicit 14-digit timestamp');path=options.timestamp+path;}
 else if(options.timestamp!==undefined)throw new Error('Timestamp is only supported for unique-name boards');
 const bytes=plan.conversion==='robin'?encodeRobin(input):plan.conversion==='chitu'?encodeChitu(input).firmware:Buffer.from(input);
 if(bytes.length>maximumFirmwareBytes)throw new RangeError('Converted firmware exceeds FAT file limit');
 return {plan,path,bytes,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length};
}
