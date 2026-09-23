import {MCUGroup} from '../../src/runtime/mcu-group.ts';
import {SerialSession} from '../../src/protocol/serial-session.ts';
import {serialClock} from '../../src/protocol/serial-queue.ts';
import {serialFirmware} from './serial-firmware.ts';
import {hardwareClocks} from './configured-hardware.ts';
export async function hardwareStartupFixture(safetyError=false,reverse=false,extendedPins=false){
 const firmware=await Promise.all([serialFirmware(undefined,{triggerSync:true,stepperBytePins:true,extendedPins}),serialFirmware(undefined,{triggerSync:true,stepperBytePins:true,extendedPins})]),stops=[0,0],signal=new AbortController().signal;
 const connections=['mcu','aux'].map((id,i)=>({id,async connect(s:AbortSignal,stopDevice:(cause:unknown)=>Promise<void>){const session=new SerialSession(firmware[i].fd,{stopDevice});await session.initialize(s);return session;},async stopDevice(){stops[i]++;if(safetyError&&i===1)throw new Error('independent safety failed');}}));const group=new MCUGroup(reverse?connections.reverse():connections);
 try{await group.start(signal);}catch(error){await Promise.all(firmware.map(f=>f.close()));throw error;}
 const clocks=hardwareClocks();for(const [id,c] of clocks)c.currentPrintTime=Number(group.session(id).clock.sync.getClock(serialClock.now()))/1e6;
 return {firmware,group,clocks,stops,signal,async close(){try{await group.stop();}finally{await Promise.all(firmware.map(f=>f.close()));}}};
}
