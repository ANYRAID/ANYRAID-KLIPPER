import type {SerialSession} from '../protocol/serial-session.ts';
import {i2cFormats} from '../protocol/i2c-config.ts';
export interface I2cDevice {transfer(write:Uint8Array,readLength:number,signal:AbortSignal):Promise<Uint8Array>;}
const owners=new WeakMap<SerialSession,Map<number,I2cDevice>>();
/** Status-confirmed transfers, including writes. No application-level replay:
 * a lost response cannot prove whether a peripheral consumed a write. */
export function sessionI2c(session:SerialSession,oid:number):I2cDevice{
 session.assertActive();if(!Number.isInteger(oid)||oid<0||oid>254)throw new RangeError('Invalid I2C OID');
 let devices=owners.get(session);const existing=devices?.get(oid);if(existing)return existing;
 const d=session.dictionary;for(const key of ['config','transfer','response'] as const)d.lookup(i2cFormats[key]);
 const queue=session.commandQueue();let tail:Promise<void>=Promise.resolve(),pending=0,failed=false,fault:unknown;
 const device:I2cDevice={async transfer(write,readLength,signal){
  signal.throwIfAborted();session.assertActive();
  // Conservative single-frame bound also limits firmware stack allocation.
  if(!(write instanceof Uint8Array)||write.length>48||!Number.isInteger(readLength)||readLength<0||readLength>48)throw new RangeError('Invalid I2C transfer size');
  if(pending>=64)throw new Error('I2C request queue full');
  const payload=d.encode('i2c_transfer',{oid,write:write.slice(),read_len:readLength});if(payload.length>59)throw new RangeError('I2C command exceeds frame');
  const previous=tail,release=Promise.withResolvers<void>();tail=release.promise;pending++;
  try{await previous;signal.throwIfAborted();if(failed)throw fault;session.assertActive();
   try{
    const result=await session.queryOnQueue(queue,payload,'i2c_response',signal,{oid,retries:0,timeout:5}),p=result.message.parameters;
    signal.throwIfAborted();
    if(result.message.name!=='i2c_response'||p.oid!==oid||p.i2c_bus_status!=='SUCCESS')throw new Error(`I2C transaction failed: ${String(p.i2c_bus_status)}`);
    if(!(p.response instanceof Uint8Array)||p.response.length!==readLength)throw new Error('Malformed I2C response');
    return p.response.slice();
   }catch(error){failed=true;fault=error;try{await session.stop(error);}catch(stop){throw new AggregateError([error,stop],'I2C transaction and MCU stop failed',{cause:error});}throw error;}
  }finally{pending--;release.resolve();}
 }};
 if(!devices){devices=new Map();owners.set(session,devices);}devices.set(oid,device);return device;
}
