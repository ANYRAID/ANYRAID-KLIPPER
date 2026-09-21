import {constants,DatabaseSync,type SQLInputValue,type StatementSync,type SQLOutputValue} from 'node:sqlite';
import {ApiError,type Json} from './rpc.ts';
import {boundedJsonBytes} from './json-size.ts';
export type SqlValue=null|string|number|{integer:string}|{blob:string}|{real:number};
export interface SqlOperation {sql:string;params?:SqlValue[];many?:SqlValue[][];}
export interface SqlResult {columns:string[];rows:SqlValue[][];changes:SqlValue;lastInsertRowid:SqlValue;}
function binding(value:SqlValue):SQLInputValue{
 if(value===null||typeof value==='string')return value;
 if(typeof value==='number'){if(!Number.isFinite(value)||Number.isInteger(value)&&!Number.isSafeInteger(value))throw new ApiError(400,'Use integer or real tag for SQL numbers outside the safe integer range');return Number.isSafeInteger(value)&&!Object.is(value,-0)?BigInt(value):value;}
 if(value&&typeof value==='object'&&Object.keys(value).length===1){
  if('real' in value&&typeof value.real==='number'&&Number.isFinite(value.real))return value.real;
  if('integer' in value&&typeof value.integer==='string'&&/^(0|-?[1-9][0-9]{0,18})$/.test(value.integer)){const n=BigInt(value.integer);if(n>=-(1n<<63n)&&n<(1n<<63n))return n;}
  if('blob' in value&&typeof value.blob==='string'){const buffer=Buffer.from(value.blob,'base64');if(buffer.toString('base64')===value.blob)return buffer;}
 }
 throw new ApiError(400,'Invalid SQL binding');
}
function output(value:SQLOutputValue):SqlValue{
 if(typeof value==='bigint')return value>=BigInt(Number.MIN_SAFE_INTEGER)&&value<=BigInt(Number.MAX_SAFE_INTEGER)?Number(value):{integer:String(value)};
 if(value instanceof Uint8Array)return {blob:Buffer.from(value).toString('base64')};
 if(typeof value==='number'&&!Number.isFinite(value))throw new ApiError(422,'Nonfinite SQL result');
 return value;
}
/** Trusted internal SQL only. An entire request is one engine-owned transaction. */
export function executeSql(db:DatabaseSync,tables:string[],operations:SqlOperation[],registered:ReadonlySet<string>,limit:number):SqlResult[]{
 if(!Array.isArray(tables)||!tables.length||tables.length>256||tables.some(name=>typeof name!=='string'||!registered.has(name.toLowerCase())))throw new ApiError(400,'SQL requires registered component tables');
 if(!Array.isArray(operations)||!operations.length||operations.length>4096)throw new ApiError(400,'Invalid SQL operation count');
 const allowed=new Set(tables.map(name=>name.toLowerCase()));
 let executions=0;
 const prepared=operations.map(op=>{
  if(!op||typeof op.sql!=='string'||!op.sql.trim()||!op.sql.isWellFormed()||op.sql.includes('\0')||Buffer.byteLength(op.sql)>65536||op.params!==undefined&&!Array.isArray(op.params)||(op.params?.length??0)>4096)throw new ApiError(400,'Invalid SQL operation');
  if(op.many!==undefined&&(!Array.isArray(op.many)||op.params!==undefined||op.many.some(row=>!Array.isArray(row)||row.length>4096)))throw new ApiError(400,'Invalid SQL many bindings');
  executions+=op.many?.length??1;if(executions>4096)throw new ApiError(413,'SQL execution count exceeds limit');
  return {sql:op.sql,params:(op.params??[]).map(binding),many:op.many?.map(row=>row.map(binding))};
 });
 const results:SqlResult[]=[],statements=new Map<string,StatementSync>();let bytes=2;
 db.setAuthorizer((action,a,b,database)=>{
  if(database!==null&&database!=='main')return constants.SQLITE_DENY;
  if([constants.SQLITE_SELECT,constants.SQLITE_RECURSIVE].includes(action))return constants.SQLITE_OK;
  if(action===constants.SQLITE_FUNCTION)return b?.toLowerCase()==='load_extension'?constants.SQLITE_DENY:constants.SQLITE_OK;
  if([constants.SQLITE_READ,constants.SQLITE_INSERT,constants.SQLITE_UPDATE,constants.SQLITE_DELETE].includes(action)&&a&&allowed.has(a.toLowerCase()))return constants.SQLITE_OK;
  return constants.SQLITE_DENY;
 });
 try{
  for(const operation of prepared){
   let statement=statements.get(operation.sql);
   if(!statement){statement=db.prepare(operation.sql);statements.set(operation.sql,statement);
    if(operation.sql.slice(statement.sourceSQL.length).trim())throw new ApiError(400,'Each SQL operation must contain exactly one statement');
    statement.setReadBigInts(true);statement.setReturnArrays(true);
   }
    const result:SqlResult={columns:statement.columns().map(column=>column.name),rows:[],changes:null,lastInsertRowid:null};
    if(result.columns.length){
     if(operation.many!==undefined)throw new ApiError(400,'SQL many requires a statement without result columns');
     bytes+=boundedJsonBytes(result as unknown as Json,limit-bytes)+(results.length?1:0);
     for(const raw of statement.iterate(...operation.params)){
      const row=(raw as unknown as SQLOutputValue[]).map(output);bytes+=boundedJsonBytes(row,limit-bytes)+(result.rows.length?1:0);
      if(bytes>limit)throw new ApiError(413,'SQL response exceeds limit');result.rows.push(row);
     }
    }else{
     let changes=0n;for(const params of operation.many??[operation.params]){const info=statement.run(...params);changes+=BigInt(info.changes);result.lastInsertRowid=output(info.lastInsertRowid);}result.changes=output(changes);
     bytes+=boundedJsonBytes(result as unknown as Json,limit-bytes)+(results.length?1:0);
    }
    if(bytes>limit)throw new ApiError(413,'SQL response exceeds limit');results.push(result);
  }
 }finally{try{for(const statement of statements.values())(statement as typeof statement&{close():void}).close();}finally{db.setAuthorizer(null);}}
 return results;
}
