// GPL-3.0-or-later. CAN assignment/identity contract from klippy/serialhdl.py.
import {closeSync} from 'node:fs';
import {createRequire} from 'node:module';
import {SerialSession,type SerialSessionOptions} from './serial-session.ts';
interface Native {openCAN(name:string,clientId:number,uuid:Buffer):number;}
export interface CANOptions extends Omit<SerialSessionOptions,'canClientId'> {nodeId?:number;timeoutMs?:number;}
export function canIdentity(uuid:string,nodeId=64):{uuid:Buffer;nodeId:number;clientId:number}{
 if(typeof uuid!=='string'||! /^(?:0x)?[0-9a-f]{1,12}$/i.test(uuid)||!Number.isInteger(nodeId)||nodeId<0||nodeId>255)throw new TypeError('Invalid CAN UUID or node ID');
 return {uuid:Buffer.from(uuid.replace(/^0x/i,'').padStart(12,'0'),'hex'),nodeId,clientId:256+nodeId*2};
}
/** Assign once, initialize, then verify both UUID and node ID before returning.
 * No automatic reconnect or assignment replay. Caller owns shutdown policy and
 * must choose a bus/node ID suitable for commissioning, not an active print. */
export async function connectCAN(name:string,uuid:string,options:CANOptions,signal:AbortSignal):Promise<SerialSession>{
 signal.throwIfAborted();options={...options};const identity=canIdentity(uuid,options.nodeId),timeout=options.timeoutMs??60000;
 if(!/^[A-Za-z0-9_.:-]{1,15}$/.test(name)||typeof options.stopDevice!=='function'||!Number.isInteger(timeout)||timeout<1||timeout>60000||'canClientId' in options)throw new TypeError('Invalid CAN connection options');
 const lifetime=AbortSignal.any([signal,AbortSignal.timeout(timeout)]),native=createRequire(import.meta.url)(process.env.ANYRAID_SERIALQUEUE_ADDON??'../../build/serialqueue.node') as Native;
 let fd=-1,session:SerialSession|undefined;
 try{
  lifetime.throwIfAborted();fd=native.openCAN(name,identity.clientId,identity.uuid);session=new SerialSession(fd,{stopDevice:options.stopDevice,onMessage:options.onMessage,diagnosticCommands:options.diagnosticCommands,canClientId:identity.clientId});const owned=fd;fd=-1;closeSync(owned);
  await session.initialize(lifetime);const dictionary=session.dictionary;const command=dictionary.lookup('get_canbus_id'),response=dictionary.lookup('canbus_id canbus_uuid=%*s canbus_nodeid=%u');
  const result=await session.query(dictionary.encode(command.name,{}),response.name,lifetime,{retries:0}),actual=result.message.parameters.canbus_uuid;
  if(!(actual instanceof Uint8Array)||actual.length!==6||!Buffer.from(actual).equals(identity.uuid)||result.message.parameters.canbus_nodeid!==identity.nodeId)throw new Error('CAN firmware identity mismatch');
  lifetime.throwIfAborted();return session;
 }catch(error){if(session)try{await session.stop(error);}catch{/* failure retained in session status */}throw error;}
 finally{if(fd>=0)closeSync(fd);}
}
