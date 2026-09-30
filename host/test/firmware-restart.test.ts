import test from 'node:test';
import assert from 'node:assert/strict';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {resetConfiguredFirmware} from '../src/runtime/firmware-restart.ts';
import type {MCUMachinePolicy} from '../src/runtime/configured-mcu-connections.ts';
import {ptyPair} from './helpers/pty.ts';
import {serialFirmware} from './helpers/serial-firmware.ts';
test('one missing MCU reset capability is discovered before resetting the other MCU',async()=>{
 const pairs=[ptyPair(),ptyPair()],firmware=await Promise.all(pairs.map((pair,i)=>serialFirmware(pair,{reset:i===0?'ack':undefined}))),stops=[0,0];
 const reader=new ConfigurationReader(new ConfigurationSource('/printer.cfg',{mcu:{serial:pairs[0].path},'mcu aux':{serial:pairs[1].path}},[]),null),policies=new Map<string,MCUMachinePolicy>(['mcu','aux'].map((id,i)=>[id,{transport:'uart',rts:false,leaveBootloader:false,stopDevice:async()=>{stops[i]++;}}]));
 try{await assert.rejects(resetConfiguredFirmware(reader,policies,new AbortController().signal),/Unknown/);assert.deepEqual(firmware.map(m=>m.configurationTraffic.resets),[0,0]);assert.deepEqual(stops,[2,2]);}finally{await Promise.all(firmware.map(m=>m.close()));}
});
