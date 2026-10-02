import {constants,DatabaseSync,type SQLInputValue,type StatementSync,type SQLOutputValue} from 'node:sqlite';
import {ApiError,type Json} from './rpc.ts';
import {boundedJsonBytes} from './json-size.ts';
export type SqlValue=null|string|number|{integer:string}|{blob:string}|{real:number};
export interface SqlOperation {sql:string;params?:SqlValue[];many?:SqlValue[][];expectRows?:number;}
export interface SqlResult {columns:string[];rows:SqlValue[][];changes:SqlValue;lastInsertRowid:SqlValue;}
interface SqlPlans {scope?:{allowed:Set<string>;readOnly:boolean};statements:Map<string,StatementSync>;schemaProbe:StatementSync;}
const planCaches=new WeakMap<DatabaseSync,SqlPlans>();
const closeStatement=(statement:StatementSync)=>(statement as StatementSync&{close():void}).close();
function authorize(scope:SqlPlans['scope'],action:number,a:string|null,b:string|null,database:string|null):number{
 if(!scope)return constants.SQLITE_OK;
 const {allowed,readOnly}=scope;
 if(database!==null&&database!=='main')return constants.SQLITE_DENY;
 if([constants.SQLITE_SELECT,constants.SQLITE_RECURSIVE].includes(action))return constants.SQLITE_OK;
 if(action===constants.SQLITE_FUNCTION)return b?.toLowerCase()==='load_extension'?constants.SQLITE_DENY:constants.SQLITE_OK;
 if((action===constants.SQLITE_READ||!readOnly&&[constants.SQLITE_INSERT,constants.SQLITE_UPDATE,constants.SQLITE_DELETE].includes(action))&&a&&allowed.has(a.toLowerCase()))return constants.SQLITE_OK;
 return constants.SQLITE_DENY;
}
/** Internal engine SQL executes outside this scope. Component statements are
 * authorized both during initial compilation and automatic schema reprepare. */
function sqlPlans(db:DatabaseSync):SqlPlans{
 let cache=planCaches.get(db);if(cache)return cache;
 cache={statements:new Map(),schemaProbe:db.prepare('SELECT 1 FROM main.sqlite_schema LIMIT 1')};const owner=cache;
 db.setAuthorizer((action,a,b,database)=>authorize(owner.scope,action,a,b,database));planCaches.set(db,cache);return cache;
}
/** Table migration installs its own authorizer; release plans before that, or close. */
export function releaseSqlPlans(db:DatabaseSync):void{
 const cache=planCaches.get(db);if(!cache)return;planCaches.delete(db);
 try{for(const statement of cache.statements.values())closeStatement(statement);}finally{cache.statements.clear();try{closeStatement(cache.schemaProbe);}finally{db.setAuthorizer(null);}}
}
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
/** Trusted internal SQL only. The engine owns transaction policy; readOnly
 * denies mutation and schema actions through SQLite authorization. */
export function executeSql(db:DatabaseSync,tables:string[],operations:SqlOperation[],registered:ReadonlySet<string>,limit:number,readOnly=false):SqlResult[]{
 if(!Array.isArray(tables)||!tables.length||tables.length>256||tables.some(name=>typeof name!=='string'||!registered.has(name.toLowerCase())))throw new ApiError(400,'SQL requires registered component tables');
 if(!Array.isArray(operations)||!operations.length||operations.length>4096)throw new ApiError(400,'Invalid SQL operation count');
 const allowed=new Set(tables.map(name=>name.toLowerCase()));
 let executions=0;
 const prepared=operations.map(op=>{
  if(!op||typeof op.sql!=='string'||!op.sql.trim()||!op.sql.isWellFormed()||op.sql.includes('\0')||Buffer.byteLength(op.sql)>65536||op.params!==undefined&&!Array.isArray(op.params)||(op.params?.length??0)>4096)throw new ApiError(400,'Invalid SQL operation');
  if(op.expectRows!==undefined&&(!Number.isSafeInteger(op.expectRows)||op.expectRows<0))throw new ApiError(400,'Invalid SQL expected row count');
  if(op.many!==undefined&&(!Array.isArray(op.many)||op.params!==undefined||op.many.some(row=>!Array.isArray(row)||row.length>4096)))throw new ApiError(400,'Invalid SQL many bindings');
  executions+=op.many?.length??1;if(executions>4096)throw new ApiError(413,'SQL execution count exceeds limit');
  return {sql:op.sql,params:(op.params??[]).map(binding),many:op.many?.map(row=>row.map(binding)),expectRows:op.expectRows};
 });
 const results:SqlResult[]=[],statements=new Map<string,StatementSync>();let bytes=2;
 if(planCaches.get(db)?.scope)throw new ApiError(500,'Nested component SQL is not supported');
 const scope={allowed,readOnly},cache=readOnly?sqlPlans(db):undefined;
  if(cache)cache.scope=scope;else{releaseSqlPlans(db);db.setAuthorizer((action,a,b,database)=>authorize(scope,action,a,b,database));}
 const scopeKey=cache?JSON.stringify([...allowed].sort()):'';let retained:StatementSync|undefined;
 try{
  for(const operation of prepared){
   // StatementSync may retain bound values until the next execution. Do not
   // keep large text/blob parameters alive just to reuse their query plan.
   const smallBindings=readOnly&&prepared.length===1&&operation.params.reduce<number>((bytes,value)=>bytes+(typeof value==='string'?Buffer.byteLength(value):value instanceof Uint8Array?value.byteLength:8),0)<=8192;
   const key=smallBindings?JSON.stringify([scopeKey,operation.sql]):undefined;
   let statement=key===undefined?statements.get(operation.sql):cache!.statements.get(key);
   if(key!==undefined&&statement){cache!.statements.delete(key);cache!.statements.set(key,statement);}
   if(!statement){
    if(cache){cache.scope=undefined;try{cache.schemaProbe.get();}finally{cache.scope=scope;}}
    statement=db.prepare(operation.sql);statements.set(operation.sql,statement);
    if(operation.sql.slice(statement.sourceSQL.length).trim())throw new ApiError(400,'Each SQL operation must contain exactly one statement');
    statement.setReadBigInts(true);statement.setReturnArrays(true);
    if(key!==undefined){while(cache!.statements.size>=32){const oldest=cache!.statements.keys().next().value!;closeStatement(cache!.statements.get(oldest)!);cache!.statements.delete(oldest);}cache!.statements.set(key,statement);}
   }
    if(key!==undefined)retained=statement;
    const columns=statement.columns();
    const result:SqlResult={columns:readOnly?[]:columns.map(column=>column.name),rows:[],changes:null,lastInsertRowid:null};
    if(columns.length){
     if(operation.many!==undefined)throw new ApiError(400,'SQL many requires a statement without result columns');
     bytes+=boundedJsonBytes(result as unknown as Json,limit-bytes)+(results.length?1:0);
     for(const raw of statement.iterate(...operation.params)){
      const row=(raw as unknown as SQLOutputValue[]).map(output);bytes+=boundedJsonBytes(row,limit-bytes)+(result.rows.length?1:0);
      if(bytes>limit)throw new ApiError(413,'SQL response exceeds limit');result.rows.push(row);
     }
     // Schema changes can trigger reprepare on the first step; column metadata
     // must describe that execution, not the previously cached statement.
     if(readOnly){result.columns=statement.columns().map(column=>column.name);bytes+=boundedJsonBytes(result.columns,limit-bytes+2)-2;}
    }else{
     let changes=0n;for(const params of operation.many??[operation.params]){const info=statement.run(...params);changes+=BigInt(info.changes);result.lastInsertRowid=output(info.lastInsertRowid);}result.changes=output(changes);
     bytes+=boundedJsonBytes(result as unknown as Json,limit-bytes)+(results.length?1:0);
    }
    if(operation.expectRows!==undefined&&result.rows.length!==operation.expectRows)throw new ApiError(409,'SQL result row invariant failed');
    if(bytes>limit)throw new ApiError(413,'SQL response exceeds limit');results.push(result);
  }
 }catch(error){
  // Failed automatic reprepare can poison a StatementSync until finalized.
  // Never retain that error state across a later valid schema or request.
  if(retained){for(const [key,statement] of cache!.statements)if(statement===retained)cache!.statements.delete(key);for(const [key,statement] of statements)if(statement===retained)statements.delete(key);try{closeStatement(retained);}catch{/* preserve the query error */}retained=undefined;}
  throw error;
 }finally{try{for(const statement of statements.values())if(statement!==retained)closeStatement(statement);}finally{if(cache)cache.scope=undefined;else db.setAuthorizer(null);}}
 return results;
}
