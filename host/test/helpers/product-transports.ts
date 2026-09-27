import {ConfigurationReader} from '../../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../../src/moonraker/config-source.ts';
import {ptyPair} from './pty.ts';
import {serialFirmware} from './serial-firmware.ts';
import type {MCUMachinePolicy} from '../../src/runtime/configured-mcu-connections.ts';
export async function productTransports(reader:ConfigurationReader,buttons=false){
 const pairs=[ptyPair(),ptyPair()],firmware=await Promise.all(pairs.map(p=>serialFirmware(p,{triggerSync:true,stepperBytePins:true,extendedPins:true,buttons}))),stops=[0,0];
 const policies=new Map<string,MCUMachinePolicy>(['mcu','aux'].map((id,i)=>[id,{transport:'uart',rts:true,leaveBootloader:false,stopDevice:async()=>{stops[i]++;}}]));
 const configured=new ConfigurationReader(new ConfigurationSource('/printer.cfg',{...reader.source.original,mcu:{serial:pairs[0].path},'mcu aux':{serial:pairs[1].path}},[]),null);
 return {reader:configured,policies,firmware,stops,async close(){await Promise.all(firmware.map(f=>f.close()));}};
}
