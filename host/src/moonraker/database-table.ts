import {constants,DatabaseSync} from 'node:sqlite';
import {ApiError,type Json} from './rpc.ts';
/** Trusted component migrations only; never accept definitions from HTTP/RPC. */
export interface DatabaseTableDefinition {name:string;prototype:string;version:number;migrations?:Record<string,string[]>;}
export function tableDefinition(input:DatabaseTableDefinition):DatabaseTableDefinition{
 if(!input||typeof input!=='object'||typeof input.name!=='string'||!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(input.name)||['namespace_store','table_registry'].includes(input.name.toLowerCase()))throw new ApiError(400,'Invalid or reserved table name');
 if(typeof input.prototype!=='string'||!input.prototype.isWellFormed()||Buffer.byteLength(input.prototype)>65536||!input.prototype.trim().startsWith(input.name+' ')&&!input.prototype.trim().startsWith(input.name+'(')||!Number.isSafeInteger(input.version)||input.version<1||input.version>1000000)throw new ApiError(400,'Invalid table definition');
 if(input.migrations!==undefined&&(!input.migrations||typeof input.migrations!=='object'||Array.isArray(input.migrations)))throw new ApiError(400,'Invalid table migrations');let bytes=0;const migrations:Record<string,string[]>={};
 for(const [from,sql] of Object.entries(input.migrations??{})){if(!/^(0|[1-9][0-9]*)$/.test(from)||Number(from)>=input.version||!Array.isArray(sql)||sql.length>256||sql.some(statement=>typeof statement!=='string'||!statement.trim()||!statement.isWellFormed()||statement.includes('\0')))throw new ApiError(400,'Invalid migration source or SQL');for(const statement of sql)bytes+=Buffer.byteLength(statement);if(bytes>1024*1024||Object.keys(migrations).length>=128)throw new ApiError(413,'Table migration exceeds limit');Object.defineProperty(migrations,from,{value:[...sql],enumerable:true});}
 return {name:input.name,prototype:input.prototype.trim(),version:input.version,migrations};
}
/** Executes inside the engine-owned transaction. SQL cannot change transaction
 * boundaries, attach files, change pragmas, or write unrelated component tables. */
export function migrateTable(db:DatabaseSync,definition:DatabaseTableDefinition):Json{
 const {name,prototype,version,migrations}=tableDefinition(definition),found=db.prepare("SELECT name,type FROM sqlite_schema WHERE name=? COLLATE NOCASE").get(name),record=db.prepare('SELECT name,prototype,version FROM table_registry WHERE name=? COLLATE NOCASE').get(name);
 if(found&&found.name!==name||record&&record.name!==name)throw new ApiError(409,'Table name casing differs from stored definition');
 if(found&&found.type!=='table')throw new ApiError(409,'Table name belongs to another schema object');if(!found&&record)throw new ApiError(409,'Registered table is missing');
 const previous=record?.version??0;if(typeof previous!=='number'||!Number.isSafeInteger(previous)||previous<0||typeof record?.prototype!=='string'&&record!==undefined)throw new ApiError(422,'Invalid table registration');
 if(previous>version)throw new ApiError(409,'Database table version is newer than this component');if(previous===version&&record!.prototype!==prototype)throw new ApiError(409,'Table prototype differs at the same version');
 const expected=new DatabaseSync(':memory:');let expectedColumns:unknown;
 try{expected.setAuthorizer((action,a)=>{if([constants.SQLITE_ATTACH,constants.SQLITE_DETACH,constants.SQLITE_PRAGMA,constants.SQLITE_TRANSACTION,constants.SQLITE_CREATE_VTABLE,constants.SQLITE_CREATE_TRIGGER,constants.SQLITE_CREATE_VIEW].includes(action)||action===constants.SQLITE_CREATE_TABLE&&a!==name||[constants.SQLITE_INSERT,constants.SQLITE_UPDATE,constants.SQLITE_DELETE].includes(action)&&a!=='sqlite_master'&&a!=='sqlite_schema')return constants.SQLITE_DENY;return constants.SQLITE_OK;});expected.exec('CREATE TABLE '+prototype);expected.setAuthorizer(null);expectedColumns=expected.prepare('PRAGMA table_xinfo('+name+')').all();}finally{expected.close();}
 if(previous===version){if(JSON.stringify(db.prepare('PRAGMA table_xinfo('+name+')').all())!==JSON.stringify(expectedColumns))throw new ApiError(409,'Stored table columns differ from definition');return {name,version,previousVersion:previous,created:false,migrated:false};}
 const sql=migrations?.[String(previous)];if(found&&sql===undefined)throw new ApiError(409,'Missing migration for existing table version');
 const existingNames=new Set<string>();for(const row of db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").iterate()){if(existingNames.size>=4096)throw new ApiError(413,'Too many database tables');existingNames.add(String(row.name).toLowerCase());}
 const own=(value:string|null)=>{const candidate=value?.toLowerCase(),base=name.toLowerCase();return candidate===base||candidate?.startsWith(base+'__')===true&&!existingNames.has(candidate);};
 db.setAuthorizer((action,a,b,database)=>{
  if(database!==null&&database!=='main')return constants.SQLITE_DENY;
  if([constants.SQLITE_TRANSACTION,constants.SQLITE_SAVEPOINT,constants.SQLITE_ATTACH,constants.SQLITE_DETACH,constants.SQLITE_PRAGMA,constants.SQLITE_CREATE_VTABLE,constants.SQLITE_DROP_VTABLE,constants.SQLITE_CREATE_TRIGGER,constants.SQLITE_CREATE_VIEW].includes(action))return constants.SQLITE_DENY;
  if(action===constants.SQLITE_FUNCTION&&b?.toLowerCase()==='load_extension')return constants.SQLITE_DENY;
  if([constants.SQLITE_INSERT,constants.SQLITE_UPDATE,constants.SQLITE_DELETE].includes(action)&&!own(a)&&a!=='sqlite_master'&&a!=='sqlite_schema')return constants.SQLITE_DENY;
  if([constants.SQLITE_CREATE_TABLE,constants.SQLITE_DROP_TABLE,constants.SQLITE_CREATE_VIEW,constants.SQLITE_DROP_VIEW].includes(action)&&!own(a))return constants.SQLITE_DENY;
  if([constants.SQLITE_CREATE_INDEX,constants.SQLITE_DROP_INDEX,constants.SQLITE_CREATE_TRIGGER,constants.SQLITE_DROP_TRIGGER].includes(action)&&!own(b))return constants.SQLITE_DENY;
  if(action===constants.SQLITE_ALTER_TABLE&&!own(b))return constants.SQLITE_DENY;
  return constants.SQLITE_OK;
 });
 try{if(!found)db.exec('CREATE TABLE '+prototype);for(const statement of sql??[])db.exec(statement);}finally{db.setAuthorizer(null);}
 if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name))throw new ApiError(409,'Migration did not leave the registered table');
 if(JSON.stringify(db.prepare('PRAGMA table_xinfo('+name+')').all())!==JSON.stringify(expectedColumns))throw new ApiError(409,'Migrated table columns differ from definition');
 db.prepare('INSERT INTO table_registry VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET prototype=excluded.prototype,version=excluded.version').run(name,prototype,version);
 return {name,version,previousVersion:previous,created:!found,migrated:true};
}
