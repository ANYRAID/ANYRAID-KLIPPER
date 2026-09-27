import {encodeTmcRead,encodeTmcWrite} from '../../src/drivers/tmc-uart.ts';
import assert from 'node:assert/strict';
import {ConfigurationReader} from '../../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../../src/moonraker/config-source.ts';
import {ptyPair} from './pty.ts';
import {serialFirmware} from './serial-firmware.ts';
import type {MCUMachinePolicy} from '../../src/runtime/configured-mcu-connections.ts';
export async function productTransports(reader:ConfigurationReader,buttons=false,tmc=false,spi=false,software=false){
 const tmcState=[0,1].map(()=>({fault:0,statusReads:0,writes:0,counts:new Map<number,number>(),registers:new Map<string,number>()}));
 const spiLatched=[Buffer.alloc(20),Buffer.alloc(20)];
 const pairs=[ptyPair(),ptyPair()],firmware=await Promise.all(pairs.map((p,index)=>serialFirmware(p,{triggerSync:true,stepperBytePins:true,extendedPins:true,buttons,...spi?{spiSoftware:software?'modern' as const:undefined,spiPins:'PA15,PA16,PA17',tmcSpi:(_oid:number,frame:Uint8Array,read:boolean)=>{
  const state=tmcState[index],previous=spiLatched[index],next=Buffer.alloc(20),bytes=Buffer.from(frame);assert.equal(bytes.length,20);
  for(let offset=0;offset<20;offset+=5){const address=3-offset/5,reg=bytes[offset]&127,key=address+':'+reg;if(bytes[offset]&128){state.registers.set(key,bytes.readUInt32BE(offset+1));state.writes++;}else if(reg===1||reg===0x6f)state.statusReads++;
   const value=reg===1?0:reg===0x51?2808:reg===0x6f?(((state.registers.get(address+':16')??0)&0x1f00)<<8)|(state.fault?1<<25:0):state.registers.get(key)??0;next.writeUInt32BE(value>>>0,offset+1);
  }spiLatched[index]=next;return {data:previous,delayMs:read?3:undefined};
 }}:tmc?{tmcUart:(_oid:number,frame:Uint8Array,read:number)=>{
  const state=tmcState[index],byte=(i:number)=>{const bit=i*10+1;return ((frame[bit>>>3]|frame[(bit>>>3)+1]<<8)>>>(bit&7))&255;},address=byte(1),reg=byte(2)&127,key=address+':'+reg;
  if(read){assert.deepEqual(Buffer.from(frame),encodeTmcRead(address,reg));if(reg===1||reg===0x6f)state.statusReads++;return {data:encodeTmcWrite(255,reg,reg===2?state.counts.get(address)??0:reg===1?state.fault:reg===0x51?2808:state.registers.get(key)??0,true),delayMs:3};}
  const value=byte(3)*2**24+byte(4)*65536+byte(5)*256+byte(6);assert.deepEqual(Buffer.from(frame),encodeTmcWrite(address,reg,value));state.writes++;state.counts.set(address,((state.counts.get(address)??0)+1)&255);state.registers.set(key,value);return {data:Buffer.alloc(0),delayMs:2};
 }}:{}}))),stops=[0,0];
 const policies=new Map<string,MCUMachinePolicy>(['mcu','aux'].map((id,i)=>[id,{transport:'uart',rts:true,leaveBootloader:false,stopDevice:async()=>{stops[i]++;}}]));
 const configured=new ConfigurationReader(new ConfigurationSource('/printer.cfg',{...reader.source.original,mcu:{serial:pairs[0].path},'mcu aux':{serial:pairs[1].path}},[]),null);
 return {reader:configured,policies,firmware,stops,tmcState,async close(){await Promise.all(firmware.map(f=>f.close()));}};
}
