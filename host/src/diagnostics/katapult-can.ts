import {closeSync,readSync,writeSync} from 'node:fs';
import {createRequire} from 'node:module';
import {endianness} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {katapultStream} from './katapult-stream.ts';
import {flashKatapultFirmware} from './firmware-identity.ts';
const little=endianness()==='LE';
export function katapultCanAddress(uuid:string,nodeId=129){
 if(typeof uuid!=='string'||!/^(?:0x)?[a-f\d]{1,12}$/i.test(uuid)||!Number.isInteger(nodeId)||nodeId<0||nodeId>255)throw new TypeError('Invalid Katapult CAN identity');
 return {uuid:uuid.replace(/^0x/i,'').padStart(12,'0').toLowerCase(),nodeId,clientId:256+2*nodeId};
}
export function katapultCanPacket(id:number,payload:Uint8Array):Buffer{
 if(!Number.isInteger(id)||id<0||id>0x7ff||payload.length>8)throw new RangeError('Invalid standard CAN frame');
 const frame=Buffer.alloc(16);if(little)frame.writeUInt32LE(id);else frame.writeUInt32BE(id);frame[4]=payload.length;frame.set(payload,8);return frame;
}
export function katapultCanPayload(frame:Buffer,expectedId:number):Buffer{
 if(frame.length!==16||frame[4]>8||(little?frame.readUInt32LE():frame.readUInt32BE())!==expectedId)throw new Error('Invalid Katapult CAN response');
 return frame.subarray(8,8+frame[4]);
}
/** Device must already run Katapult. Assigns only the requested UUID; does not
 * broadcast clear-node-IDs or reboot. Caller must reserve nodeId on idle bus. */
export async function openKatapultCAN(name:string,uuid:string,options:{nodeId?:number}={},signal:AbortSignal){
 signal.throwIfAborted();const identity=katapultCanAddress(uuid,options.nodeId);
 if(typeof name!=='string'||!/^[A-Za-z0-9_.:-]{1,15}$/.test(name))throw new TypeError('Invalid CAN interface');
 const native=createRequire(import.meta.url)(process.env.ANYRAID_SERIALQUEUE_ADDON??'../../build/serialqueue.node') as {openCAN(name:string,id:number):number};
 const fd=native.openCAN(name,identity.clientId),packet=Buffer.alloc(16);
 const transport=katapultStream({
  write(bytes,offset){const count=Math.min(8,bytes.length-offset),frame=katapultCanPacket(identity.clientId,bytes.subarray(offset,offset+count));if(writeSync(fd,frame)!==16)throw new Error('Short Katapult CAN write');return count;},
  read(buffer){const count=readSync(fd,packet);if(count!==16)throw new Error('Short Katapult CAN read');const data=katapultCanPayload(packet,identity.clientId+1);data.copy(buffer);return data.length;},
  close:()=>closeSync(fd),
 },false,signal);
 try{
  const assignment=katapultCanPacket(0x3f0,Buffer.concat([Buffer.from([0x11]),Buffer.from(identity.uuid,'hex'),Buffer.from([identity.nodeId])]));
  signal.throwIfAborted();if(writeSync(fd,assignment)!==16)throw new Error('Short Katapult node assignment');
  await delay(500,undefined,{signal});signal.throwIfAborted();return {...transport,identity};
 }catch(error){try{transport.close();}catch{/* preserve assignment failure */}throw signal.aborted?signal.reason:error;}
}
export async function flashKatapultCAN(name:string,uuid:string,image:Uint8Array,signal:AbortSignal,options:{nodeId?:number;expectedMcu?:string}={}){
 signal.throwIfAborted();if(!image.length||image.length>64*1024*1024)throw new RangeError('Invalid firmware size');
 options={...options};const snapshot=Buffer.from(image),transport=await openKatapultCAN(name,uuid,options,signal);
 try{return await flashKatapultFirmware(snapshot,transport,signal,{expectedMcu:options.expectedMcu,expectedUuid:transport.identity.uuid});}finally{transport.close();}
}
