import {DatabaseSync,type StatementSync} from 'node:sqlite';
import {ApiError,type Json} from './rpc.ts';
import {databaseNamespace,databaseKey,databaseBatchKeys,databaseObject,ownDatabaseField,encodeDatabaseRecord,decodeDatabaseRecord,type DatabaseKey} from './database-record.ts';
export interface DatabaseOptions {path:string;maxRecordBytes?:number;maxDatabaseBytes?:number;maxReplyBytes?:number;}
const prototype='namespace_store (\n    namespace TEXT NOT NULL,\n    key TEXT NOT NULL,\n    value record NOT NULL,\n    PRIMARY KEY (namespace, key)\n)';
/** Synchronous engine owned exclusively by a Worker. Every read-modify-write
 * happens in one SQLite transaction, including nested-key operations. */
export class DatabaseEngine {
 readonly #statements=new Map<string,StatementSync>();
 readonly #db:DatabaseSync;readonly #recordBytes:number;readonly #replyBytes:number;#closed=false;
 constructor(options:DatabaseOptions){
  this.#recordBytes=options.maxRecordBytes??1024*1024;this.#replyBytes=options.maxReplyBytes??8*1024*1024;
  this.#db=new DatabaseSync(options.path,{timeout:1000});
  try{
   this.#db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
   const pageSize=Number(this.#prepare('PRAGMA page_size').get()!.page_size),pages=Math.floor((options.maxDatabaseBytes??256*1024*1024)/pageSize);
   if(Number(this.#prepare('PRAGMA page_count').get()!.page_count)>pages)throw new ApiError(413,'Database exceeds configured capacity');
   this.#db.exec(`PRAGMA max_page_count=${pages}`);
   this.#transaction(()=>{this.#db.exec(`CREATE TABLE IF NOT EXISTS ${prototype}; CREATE TABLE IF NOT EXISTS table_registry (name TEXT NOT NULL PRIMARY KEY, prototype TEXT NOT NULL, version INT)`);
   const schema=this.#prepare('PRAGMA table_info(namespace_store)').all();if(schema.length!==3||schema.some((r,i)=>r.name!==['namespace','key','value'][i]||r.type!==['TEXT','TEXT','record'][i]||r.pk!==[1,2,0][i]||r.notnull!==1))throw new ApiError(422,'Unsupported namespace table schema');
   this.#prepare('INSERT INTO table_registry VALUES(?,?,?) ON CONFLICT(name) DO NOTHING').run('namespace_store',prototype,1);});
  }catch(error){this.#db.close();throw error;}
 }
 #prepare(sql:string):StatementSync{let statement=this.#statements.get(sql);if(!statement){statement=this.#db.prepare(sql);this.#statements.set(sql,statement);}return statement;}
 #record(namespace:string,key:string):Json{const value=this.#lookup(namespace,key);if(value===undefined)throw new ApiError(404,'Database key not found');return value;}
 #lookup(namespace:string,key:string):Json|undefined{const row=this.#prepare('SELECT value FROM namespace_store WHERE namespace=? AND key=?').get(namespace,key);if(!row)return undefined;if(!(row.value instanceof Uint8Array)||row.value.byteLength>this.#recordBytes)throw new ApiError(422,'Invalid or oversized persisted record');return decodeDatabaseRecord(row.value);}
 #write(namespace:string,key:string,value:Json){const data=encodeDatabaseRecord(value);if(data.length>this.#recordBytes)throw new ApiError(413,'Database record exceeds limit');this.#prepare('INSERT INTO namespace_store VALUES(?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value').run(namespace,key,data);}
 #transaction<T>(action:()=>T):T{this.#db.exec('BEGIN IMMEDIATE');try{const result=action();this.#db.exec('COMMIT');return result;}catch(error){try{this.#db.exec('ROLLBACK');}catch{}throw error;}}
 get(namespace:string,key?:DatabaseKey|null):Json{
  databaseNamespace(namespace);
  if(key===undefined||key===null){const result:Record<string,Json>={};let bytes=2,found=false;for(const row of this.#prepare('SELECT key,value FROM namespace_store WHERE namespace=?').iterate(namespace)){found=true;const raw=row.value;if(!(raw instanceof Uint8Array)||typeof row.key!=='string')throw new ApiError(422,'Invalid persisted record');if(raw.byteLength>this.#recordBytes)throw new ApiError(413,'Database record exceeds limit');const decoded=decodeDatabaseRecord(raw);bytes+=Buffer.byteLength(JSON.stringify(decoded))+Buffer.byteLength(JSON.stringify(String(row.key)))+2;if(bytes>this.#replyBytes||raw.byteLength>this.#recordBytes)throw new ApiError(413,'Database namespace exceeds reply limit');ownDatabaseField(result,String(row.key),decoded);}if(!found)throw new ApiError(404,'Database namespace not found');return result;}
  const path=databaseKey(key);let record=this.#record(namespace,path[0]);for(const field of path.slice(1)){if(!databaseObject(record)||!Object.hasOwn(record,field))throw new ApiError(404,'Database key not found');record=record[field];}return record;
 }
 insert(namespace:string,key:DatabaseKey,value:Json):void{
  databaseNamespace(namespace);const path=databaseKey(key);this.#transaction(()=>{
   // Upstream ignores a top-level None, but stores None nested in an object.
   if(path.length===1){if(value!==null)this.#write(namespace,path[0],value);return;}
   let record:Json=this.#lookup(namespace,path[0])??{};if(!databaseObject(record))record={};let item=record as Record<string,Json>;
   for(const field of path.slice(1,-1)){if(!Object.hasOwn(item,field))ownDatabaseField(item,field,{});const next=item[field];if(!databaseObject(next))throw new ApiError(400,'Database parent is not an object');item=next;}
   ownDatabaseField(item,path.at(-1)!,value);this.#write(namespace,path[0],record);
  });
 }
 update(namespace:string,key:DatabaseKey,value:Json):void{
  databaseNamespace(namespace);const path=databaseKey(key);this.#transaction(()=>{
   let record=this.#record(namespace,path[0]);
   const merge=(previous:Json,next:Json):Json=>{if(databaseObject(previous)&&databaseObject(next)){for(const [field,value] of Object.entries(next))ownDatabaseField(previous,field,value);return previous;}return next;};
   if(path.length===1)record=merge(record,value);
   else{let item=record;for(const field of path.slice(1,-1)){if(!databaseObject(item)||!Object.hasOwn(item,field))throw new ApiError(404,'Database key not found');item=item[field];}const field=path.at(-1)!;if(!databaseObject(item)||!Object.hasOwn(item,field))throw new ApiError(400,'Database update target not found');ownDatabaseField(item,field,merge(item[field],value));}
   if(record!==null)this.#write(namespace,path[0],record);
  });
 }
 insertBatch(namespace:string,records:Record<string,Json>):void{
  databaseNamespace(namespace);if(!records||!databaseObject(records))throw new ApiError(400,'Invalid database batch records');const keys=databaseBatchKeys(Object.keys(records));
  this.#transaction(()=>{for(let offset=0;offset<keys.length;offset+=64){const chunk=keys.slice(offset,offset+64),parameters:(string|Buffer)[]=[];for(const key of chunk){const encoded=encodeDatabaseRecord(records[key]);if(encoded.length>this.#recordBytes)throw new ApiError(413,'Database record exceeds limit');parameters.push(namespace,key,encoded);}this.#prepare('INSERT INTO namespace_store VALUES '+chunk.map(()=>'(?,?,?)').join(',')+' ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value').run(...parameters);}});
 }
 getBatch(namespace:string,input:readonly string[]):Record<string,Json>{
  databaseNamespace(namespace);const keys=databaseBatchKeys(input),result:Record<string,Json>={};let bytes=2;
  for(const row of this.#prepare('SELECT key,value FROM namespace_store WHERE namespace=? AND key IN (SELECT value FROM json_each(?))').iterate(namespace,JSON.stringify(keys))){
   if(typeof row.key!=='string'||!(row.value instanceof Uint8Array))throw new ApiError(422,'Invalid persisted record');if(row.value.byteLength>this.#recordBytes)throw new ApiError(413,'Database record exceeds limit');const value=decodeDatabaseRecord(row.value);bytes+=Buffer.byteLength(JSON.stringify(row.key))+Buffer.byteLength(JSON.stringify(value))+2;if(bytes>this.#replyBytes)throw new ApiError(413,'Database batch exceeds reply limit');ownDatabaseField(result,row.key,value);
  }return result;
 }
 deleteBatch(namespace:string,input:readonly string[],validate?:(value:Json)=>void):Record<string,Json>{
  databaseNamespace(namespace);const keys=databaseBatchKeys(input);return this.#transaction(()=>{const result=this.getBatch(namespace,keys);validate?.(result);this.#prepare('DELETE FROM namespace_store WHERE namespace=? AND key IN (SELECT value FROM json_each(?))').run(namespace,JSON.stringify(keys));return result;});
 }
 moveBatch(namespace:string,sources:readonly string[],destinations:readonly string[]):void{
  databaseNamespace(namespace);const from=databaseBatchKeys(sources),to=databaseBatchKeys(destinations);this.#transaction(()=>{const statement=this.#prepare('UPDATE OR REPLACE namespace_store SET key=? WHERE namespace=? AND key=?');for(let i=0;i<Math.min(from.length,to.length);i++)statement.run(to[i],namespace,from[i]);});
 }
 delete(namespace:string,key:DatabaseKey,validate?:(value:Json)=>void):Json{
  databaseNamespace(namespace);const path=databaseKey(key);return this.#transaction(()=>{
   const record=this.#record(namespace,path[0]);let result=record;
   if(path.length>1){let item=record;for(const field of path.slice(1,-1)){if(!databaseObject(item)||!Object.hasOwn(item,field))throw new ApiError(404,'Database key not found');item=item[field];}const field=path.at(-1)!;if(!databaseObject(item)||!Object.hasOwn(item,field))throw new ApiError(404,'Database key not found');result=item[field];delete item[field];}
   validate?.(result);
   if(path.length===1||databaseObject(record)&&!Object.keys(record).length)this.#prepare('DELETE FROM namespace_store WHERE namespace=? AND key=?').run(namespace,path[0]);else this.#write(namespace,path[0],record);return result;
  });
 }
 list():string[]{const result:string[]=[];let bytes=2;for(const row of this.#prepare('SELECT DISTINCT namespace FROM namespace_store ORDER BY namespace').iterate()){if(typeof row.namespace!=='string')throw new ApiError(422,'Invalid persisted namespace');bytes+=Buffer.byteLength(JSON.stringify(row.namespace))+1;if(bytes>this.#replyBytes)throw new ApiError(413,'Database namespace list exceeds limit');result.push(row.namespace);}return result;}
 close(){if(this.#closed)return;this.#closed=true;this.#db.close();}
}
