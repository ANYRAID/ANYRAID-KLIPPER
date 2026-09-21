// Moonraker database.py record format. GPL-3.0-or-later.
import {endianness} from 'node:os';
import {ApiError,validateJson,type Json} from './rpc.ts';
import {parseRequestJson} from './json.ts';
export type DatabaseKey=string|readonly string[];
export function databaseKey(key:unknown):string[]{const result=typeof key==='string'?key.split('.'):Array.isArray(key)?[...key]:[];if(!result.length||result.length>64||result.some(v=>typeof v!=='string'||!v||!v.isWellFormed()||Buffer.byteLength(v)>1024))throw new ApiError(400,'Invalid database key');return result;}
export function databaseNamespace(namespace:unknown):asserts namespace is string{if(typeof namespace!=='string'||!namespace||!namespace.isWellFormed()||Buffer.byteLength(namespace)>1024||namespace.includes('\0'))throw new ApiError(400,'Invalid database namespace');}
export function encodeDatabaseRecord(value:Json):Buffer{
 validateJson(value);
 if(value===null)return Buffer.from([0]);
 if(typeof value==='string'){if(!value.isWellFormed())throw new ApiError(400,'Invalid Unicode database string');return Buffer.concat([Buffer.from('s'),Buffer.from(value)]);}
 if(typeof value==='boolean')return Buffer.from([63,Number(value)]);
 if(typeof value==='number'){
  const result=Buffer.allocUnsafe(9),little=endianness()==='LE';
  if(Number.isSafeInteger(value)&&!Object.is(value,-0)){result[0]=113;if(little)result.writeBigInt64LE(BigInt(value),1);else result.writeBigInt64BE(BigInt(value),1);}
  else{result[0]=100;if(little)result.writeDoubleLE(value,1);else result.writeDoubleBE(value,1);}return result;
 }
 return Buffer.from(JSON.stringify(value,(_key,item)=>typeof item==='number'&&(!Number.isSafeInteger(item)||Object.is(item,-0))?(JSON as typeof JSON&{rawJSON(text:string):unknown}).rawJSON(Object.is(item,-0)?'-0.0':item.toExponential()):item));
}
export function decodeDatabaseRecord(input:Uint8Array):Json{
 const value=Buffer.from(input);try{
  if(!value.length)throw new Error();let decoded:unknown;
  switch(value[0]){
   case 0:if(value.length!==1)throw new Error();return null;
   case 63:if(value.length!==2)throw new Error();return value[1]!==0;
   case 113:{if(value.length!==9)throw new Error();const integer=endianness()==='LE'?value.readBigInt64LE(1):value.readBigInt64BE(1);if(integer>BigInt(Number.MAX_SAFE_INTEGER)||integer<BigInt(Number.MIN_SAFE_INTEGER))throw new ApiError(422,'Stored integer exceeds safe JSON range');return Number(integer);}
   case 100:if(value.length!==9)throw new Error();decoded=endianness()==='LE'?value.readDoubleLE(1):value.readDoubleBE(1);break;
   case 115:return new TextDecoder('utf-8',{fatal:true}).decode(value.subarray(1));
   case 91:case 123:decoded=parseRequestJson(new TextDecoder('utf-8',{fatal:true}).decode(value));break;
   default:throw new Error();
  }
  validateJson(decoded);return decoded;
 }catch(error){if(error instanceof ApiError&&error.status===422)throw error;throw new ApiError(422,'Invalid persisted database record');}
}
export const databaseObject=(value:Json):value is Record<string,Json>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export function ownDatabaseField(target:Record<string,Json>,field:string,value:Json){Object.defineProperty(target,field,{value,writable:true,enumerable:true,configurable:true});}
