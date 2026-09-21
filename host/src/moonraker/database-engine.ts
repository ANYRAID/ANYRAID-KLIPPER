import {executeSql,releaseSqlPlans,type SqlOperation,type SqlResult} from './database-sql.ts';
import {migrateTable,tableDefinition,type DatabaseTableDefinition} from './database-table.ts';
import {statSync} from 'node:fs';
import {DatabaseSync,backup,type StatementSync} from 'node:sqlite';
import {ApiError,type Json} from './rpc.ts';
import {databaseNamespace,databaseKey,databaseBatchKeys,databaseObject,ownDatabaseField,encodeDatabaseRecord,decodeDatabaseRecord,type DatabaseKey} from './database-record.ts';
export interface DatabaseOptions {path:string;maxRecordBytes?:number;maxDatabaseBytes?:number;maxReplyBytes?:number;}
// Python sorted() orders Unicode code points, including astral namespace names.
function namespaceOrder(a:string,b:string):number{let i=0,j=0;while(i<a.length&&j<b.length){const x=a.codePointAt(i)!,y=b.codePointAt(j)!;if(x!==y)return x-y;i+=x>65535?2:1;j+=y>65535?2:1;}return a.length-i-(b.length-j);}
const prototype='namespace_store (\n    namespace TEXT NOT NULL,\n    key TEXT NOT NULL,\n    value record NOT NULL,\n    PRIMARY KEY (namespace, key)\n)';
/** Synchronous engine owned exclusively by a Worker. Every read-modify-write
 * happens in one SQLite transaction, including nested-key operations. */
export class DatabaseEngine {
 #tablesSealed=false;readonly #registeredTables=new Set<string>();
 readonly #registeredNamespaces=new Set(['moonraker','database']);
 readonly #namespaces=new Set<string>();#namespaceBytes=2;
 readonly #statements=new Map<string,StatementSync>();
 #restoreState:'ready'|'restored'|'restore-failed'='ready';
 readonly #maxDatabaseBytes:number;
 readonly #path:string;
 readonly #db:DatabaseSync;readonly #recordBytes:number;readonly #replyBytes:number;#closed=false;
 constructor(options:DatabaseOptions){
  this.#maxDatabaseBytes=options.maxDatabaseBytes??256*1024*1024;this.#path=options.path;this.#recordBytes=options.maxRecordBytes??1024*1024;this.#replyBytes=options.maxReplyBytes??8*1024*1024;
  this.#db=new DatabaseSync(options.path,{timeout:1000});
  try{
   this.#db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
   const pageSize=Number(this.#prepare('PRAGMA page_size').get()!.page_size),pages=Math.floor((options.maxDatabaseBytes??256*1024*1024)/pageSize);
   if(Number(this.#prepare('PRAGMA page_count').get()!.page_count)>pages)throw new ApiError(413,'Database exceeds configured capacity');
   this.#db.exec(`PRAGMA max_page_count=${pages}`);
   this.#transaction(()=>{this.#db.exec(`CREATE TABLE IF NOT EXISTS ${prototype}; CREATE TABLE IF NOT EXISTS table_registry (name TEXT NOT NULL PRIMARY KEY, prototype TEXT NOT NULL, version INT)`);
   const schema=this.#prepare('PRAGMA table_info(namespace_store)').all();if(schema.length!==3||schema.some((r,i)=>r.name!==['namespace','key','value'][i]||r.type!==['TEXT','TEXT','record'][i]||r.pk!==[1,2,0][i]||r.notnull!==1))throw new ApiError(422,'Unsupported namespace table schema');
   this.#prepare('INSERT INTO table_registry VALUES(?,?,?) ON CONFLICT(name) DO NOTHING').run('namespace_store',prototype,1);});
   for(const row of this.#prepare('SELECT DISTINCT namespace FROM namespace_store').iterate()){if(typeof row.namespace!=='string')throw new ApiError(422,'Invalid persisted namespace');this.registerNamespace(row.namespace);}
  }catch(error){this.#db.close();throw error;}
 }
 #prepare(sql:string):StatementSync{let statement=this.#statements.get(sql);if(!statement){statement=this.#db.prepare(sql);this.#statements.set(sql,statement);}return statement;}
 #record(namespace:string,key:string):Json{const value=this.#lookup(namespace,key);if(value===undefined)throw new ApiError(404,'Database key not found');return value;}
 #lookup(namespace:string,key:string):Json|undefined{const row=this.#prepare('SELECT value FROM namespace_store WHERE namespace=? AND key=?').get(namespace,key);if(!row)return undefined;if(!(row.value instanceof Uint8Array)||row.value.byteLength>this.#recordBytes)throw new ApiError(422,'Invalid or oversized persisted record');return decodeDatabaseRecord(row.value);}
 #write(namespace:string,key:string,value:Json){const data=encodeDatabaseRecord(value);if(data.length>this.#recordBytes)throw new ApiError(413,'Database record exceeds limit');this.#prepare('INSERT INTO namespace_store VALUES(?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value').run(namespace,key,data);}
 #transaction<T>(action:()=>T):T{this.#db.exec('BEGIN IMMEDIATE');try{const result=action();this.#db.exec('COMMIT');return result;}catch(error){try{this.#db.exec('ROLLBACK');}catch{}throw error;}}
 get(namespace:string,key?:DatabaseKey|null):Json{
  databaseNamespace(namespace);
  if(key===undefined||key===null){const result:Record<string,Json>={};let bytes=2;for(const row of this.#prepare('SELECT key,value FROM namespace_store WHERE namespace=?').iterate(namespace)){const raw=row.value;if(!(raw instanceof Uint8Array)||typeof row.key!=='string')throw new ApiError(422,'Invalid persisted record');if(raw.byteLength>this.#recordBytes)throw new ApiError(413,'Database record exceeds limit');const decoded=decodeDatabaseRecord(raw);bytes+=Buffer.byteLength(JSON.stringify(decoded))+Buffer.byteLength(JSON.stringify(String(row.key)))+2;if(bytes>this.#replyBytes||raw.byteLength>this.#recordBytes)throw new ApiError(413,'Database namespace exceeds reply limit');ownDatabaseField(result,String(row.key),decoded);}if(!this.#namespaces.has(namespace))throw new ApiError(404,'Database namespace not found');return result;}
  const path=databaseKey(key);let record=this.#record(namespace,path[0]);for(const field of path.slice(1)){if(!databaseObject(record)||!Object.hasOwn(record,field))throw new ApiError(404,'Database key not found');record=record[field];}return record;
 }
 insert(namespace:string,key:DatabaseKey,value:Json):void{
  databaseNamespace(namespace);const path=databaseKey(key);if(path.length>1||value!==null)this.#checkNamespaceCapacity(namespace);this.#transaction(()=>{
   // Upstream ignores a top-level None, but stores None nested in an object.
   if(path.length===1){if(value!==null)this.#write(namespace,path[0],value);return;}
   let record:Json=this.#lookup(namespace,path[0])??{};if(!databaseObject(record))record={};let item=record as Record<string,Json>;
   for(const field of path.slice(1,-1)){if(!Object.hasOwn(item,field))ownDatabaseField(item,field,{});const next=item[field];if(!databaseObject(next))throw new ApiError(400,'Database parent is not an object');item=next;}
   ownDatabaseField(item,path.at(-1)!,value);this.#write(namespace,path[0],record);
  });if(path.length>1||value!==null)this.registerNamespace(namespace);
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
 #writeBatch(namespace:string,records:Record<string,Json>,keys:readonly string[]):void{for(let offset=0;offset<keys.length;offset+=64){const chunk=keys.slice(offset,offset+64),parameters:(string|Buffer)[]=[];for(const key of chunk){const encoded=encodeDatabaseRecord(records[key]);if(encoded.length>this.#recordBytes)throw new ApiError(413,'Database record exceeds limit');parameters.push(namespace,key,encoded);}this.#prepare('INSERT INTO namespace_store VALUES '+chunk.map(()=>'(?,?,?)').join(',')+' ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value').run(...parameters);}}
 insertBatch(namespace:string,records:Record<string,Json>):void{
  databaseNamespace(namespace);if(!records||!databaseObject(records))throw new ApiError(400,'Invalid database batch records');const keys=databaseBatchKeys(Object.keys(records));this.#checkNamespaceCapacity(namespace);
  this.#transaction(()=>this.#writeBatch(namespace,records,keys));this.registerNamespace(namespace);
 }
 /** Replace an existing namespace atomically, using the same record codec as insert. */
 syncNamespace(namespace:string,records:Record<string,Json>):void{
  databaseNamespace(namespace);if(!records||!databaseObject(records))throw new ApiError(400,'Invalid database namespace records');const keys=databaseBatchKeys(Object.keys(records));
  if(!this.#namespaces.has(namespace))throw new ApiError(404,'Database namespace not found');
  this.#transaction(()=>{this.#prepare('DELETE FROM namespace_store WHERE namespace=?').run(namespace);this.#writeBatch(namespace,records,keys);});
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
 #namespacePolicy(key:string,defaults:string[]):Set<string>{const value=this.#lookup('database',key);if(value===undefined)return new Set(defaults);if(!Array.isArray(value)||value.some(item=>typeof item!=='string'))throw new ApiError(422,'Invalid persisted namespace policy');return new Set([...defaults,...value as string[]]);}
 registerLocalNamespace(namespace:string,forbidden=false):void{
  databaseNamespace(namespace);if(typeof forbidden!=='boolean')throw new ApiError(400,'Invalid namespace access policy');if(this.#registeredNamespaces.has(namespace))throw new ApiError(409,'Database namespace already registered');if(this.#registeredNamespaces.size>=4096)throw new ApiError(413,'Registered namespace capacity exceeded');
  const key=forbidden?'forbidden_namespaces':'protected_namespaces',policy=this.#namespacePolicy(key,forbidden?['database']:['moonraker']),changed=!policy.has(namespace);policy.add(namespace);
  const added=[namespace,...changed?['database']:[]].filter((name,index,all)=>all.indexOf(name)===index&&!this.#namespaces.has(name));
  if(this.#namespaceBytes+added.reduce((sum,name)=>sum+Buffer.byteLength(JSON.stringify(name))+1,0)>this.#replyBytes)throw new ApiError(413,'Database namespace list exceeds limit');
  if(changed)this.#transaction(()=>this.#write('database',key,[...policy].sort(namespaceOrder)));
  if(changed)this.registerNamespace('database');this.registerNamespace(namespace);this.#registeredNamespaces.add(namespace);
 }
 unregisterLocalNamespace(namespace:string):void{
  databaseNamespace(namespace);if(namespace==='database'||namespace==='moonraker')throw new ApiError(403,'Cannot unregister a core namespace');
  const forbidden=this.#namespacePolicy('forbidden_namespaces',['database']),protectedNames=this.#namespacePolicy('protected_namespaces',['moonraker']),removeForbidden=forbidden.delete(namespace),removeProtected=protectedNames.delete(namespace);
  if(removeForbidden||removeProtected){this.#checkNamespaceCapacity('database');this.#transaction(()=>{if(removeForbidden)this.#write('database','forbidden_namespaces',[...forbidden].sort(namespaceOrder));if(removeProtected)this.#write('database','protected_namespaces',[...protectedNames].sort(namespaceOrder));});this.registerNamespace('database');}
  this.#registeredNamespaces.delete(namespace);
 }
 hasNamespace(namespace:string):boolean{databaseNamespace(namespace);return this.#namespaces.has(namespace);}
 #checkNamespaceCapacity(namespace:string):void{if(!this.#namespaces.has(namespace)&&this.#namespaceBytes+Buffer.byteLength(JSON.stringify(namespace))+1>this.#replyBytes)throw new ApiError(413,'Database namespace list exceeds limit');}
 registerNamespace(namespace:string):void{databaseNamespace(namespace);this.#checkNamespaceCapacity(namespace);if(!this.#namespaces.has(namespace)){this.#namespaces.add(namespace);this.#namespaceBytes+=Buffer.byteLength(JSON.stringify(namespace))+1;}}
 namespaceEntries(namespace:string,mode:'keys'|'values'|'items'):Json[]{
  databaseNamespace(namespace);if(!['keys','values','items'].includes(mode))throw new ApiError(400,'Invalid namespace enumeration');const result:Json[]=[];let bytes=2;
  const columns=mode==='keys'?'key':mode==='values'?'value':'key,value';
  for(const row of this.#prepare('SELECT '+columns+' FROM namespace_store WHERE namespace=? ORDER BY key').iterate(namespace)){
   let value:Json;if(mode==='keys'){if(typeof row.key!=='string')throw new ApiError(422,'Invalid persisted key');value=row.key;}
   else{if(!(row.value instanceof Uint8Array))throw new ApiError(422,'Invalid persisted record');if(row.value.byteLength>this.#recordBytes)throw new ApiError(413,'Database record exceeds limit');value=decodeDatabaseRecord(row.value);if(mode==='items'){if(typeof row.key!=='string')throw new ApiError(422,'Invalid persisted key');value=[row.key,value];}}
   bytes+=Buffer.byteLength(JSON.stringify(value))+(result.length?1:0);if(bytes>this.#replyBytes)throw new ApiError(413,'Database namespace enumeration exceeds reply limit');result.push(value);
  }return result;
 }
 namespaceContains(namespace:string,key:DatabaseKey):boolean{
  databaseNamespace(namespace);const path=databaseKey(key);if(path.length===1)return !!this.#prepare('SELECT 1 FROM namespace_store WHERE namespace=? AND key=?').get(namespace,path[0]);
  let value=this.#lookup(namespace,path[0]);if(value===undefined)return false;for(const field of path.slice(1)){if(!databaseObject(value)||!Object.hasOwn(value,field))return false;value=value[field];}return true;
 }
 namespaceLength(namespace:string):number{databaseNamespace(namespace);return Number(this.#prepare('SELECT COUNT(*) AS count FROM namespace_store WHERE namespace=?').get(namespace)!.count);}
 clearNamespace(namespace:string):void{databaseNamespace(namespace);this.#transaction(()=>{this.#prepare('DELETE FROM namespace_store WHERE namespace=?').run(namespace);});}
 dropEmptyNamespace(namespace:string):void{databaseNamespace(namespace);if(this.#namespaces.has(namespace)&&this.namespaceLength(namespace)===0){this.#namespaces.delete(namespace);this.#namespaceBytes-=Buffer.byteLength(JSON.stringify(namespace))+1;}}
 list():string[]{return [...this.#namespaces].sort(namespaceOrder);}
 registerTable(input:DatabaseTableDefinition,validate?:(result:Json)=>void):Json{const definition=tableDefinition(input),key=definition.name.toLowerCase();if(this.#tablesSealed)throw new ApiError(409,'Table registration is closed');if(this.#registeredTables.has(key))throw new ApiError(409,'Table already registered by a component');if(this.#registeredTables.size>=256)throw new ApiError(413,'Registered table capacity exceeded');const result=this.#transaction(()=>{releaseSqlPlans(this.#db);const result=migrateTable(this.#db,definition);validate?.(result);return result;});this.#registeredTables.add(key);return result;}
 sql(tables:string[],operations:SqlOperation[],validate?:(result:Json)=>void):SqlResult[]{return this.#transaction(()=>{const result=executeSql(this.#db,tables,operations,this.#registeredTables,this.#replyBytes);validate?.(result as unknown as Json);return result;});}
 sealTableRegistration():void{this.#tablesSealed=true;}
 sqlRead(tables:string[],operation:SqlOperation,validate?:(result:Json)=>void):SqlResult{const result=executeSql(this.#db,tables,[operation],this.#registeredTables,this.#replyBytes,true)[0];validate?.(result as unknown as Json);return result;}
 get dataVersion():number{return Number(this.#prepare('PRAGMA data_version').get()!.data_version);}
 get restoreState(){return this.#restoreState;}
 async restore(path:string,validate?:(info:Json)=>void):Promise<{restored_tables:string[];restored_namespaces:string[]}>{
  if(this.#restoreState!=='ready')throw new ApiError(503,'Database awaits restart');
  let source:DatabaseSync;try{source=new DatabaseSync(path,{readOnly:true,timeout:1000});}catch{throw new ApiError(422,'Invalid restore database');}
  try{
   source.exec('PRAGMA trusted_schema=OFF; BEGIN');
   const pages=Number(source.prepare('PRAGMA page_count').get()!.page_count),pageSize=Number(source.prepare('PRAGMA page_size').get()!.page_size);if(pages*pageSize>this.#maxDatabaseBytes)throw new ApiError(413,'Restore database exceeds capacity');
   const checks=source.prepare('PRAGMA integrity_check').all();if(checks.length!==1||checks[0].integrity_check!=='ok')throw new ApiError(422,'Restore database integrity check failed');
   const schema=source.prepare('PRAGMA table_info(namespace_store)').all();if(schema.length!==3||schema.some((row,i)=>row.name!==['namespace','key','value'][i]||row.type!==['TEXT','TEXT','record'][i]||row.pk!==[1,2,0][i]||row.notnull!==1))throw new ApiError(422,'Unsupported restore namespace schema');
   let replyBytes=Buffer.byteLength(JSON.stringify({restored_tables:[],restored_namespaces:[]}));const names=(sql:string):string[]=>{const result:string[]=[];for(const row of source.prepare(sql).iterate()){if(typeof row.name!=='string')throw new ApiError(422,'Invalid restore object name');replyBytes+=Buffer.byteLength(JSON.stringify(row.name))+(result.length?1:0);if(replyBytes>this.#replyBytes)throw new ApiError(413,'Restore manifest exceeds reply limit');result.push(row.name);}return result;};
   const restored_tables=names("SELECT name FROM sqlite_schema WHERE type='table'"),restored_namespaces=names('SELECT DISTINCT namespace AS name FROM namespace_store'),info={restored_tables,restored_namespaces};validate?.(info);
   // Once replacement starts, even a lost/failed acknowledgement fences old
   // component writes until a fresh service generation opens the database.
   this.#restoreState='restore-failed';releaseSqlPlans(this.#db);await backup(source,this.#path);this.#restoreState='restored';return info;
  }catch(error){if(this.#restoreState==='restore-failed')throw new ApiError(503,'Database restore needs restart',{mayHaveCommitted:true});if(!(error instanceof ApiError))throw new ApiError(422,'Invalid restore database');throw error;}finally{try{source.exec('ROLLBACK');}catch{}source.close();}
 }
 backup(path:string):Promise<number>{return backup(this.#db,path);}
 compact():{previous_size:number;new_size:number}{const previous_size=statSync(this.#path).size;this.#db.exec('VACUUM');this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)');return {previous_size,new_size:statSync(this.#path).size};}
 close(){if(this.#closed)return;this.#closed=true;try{releaseSqlPlans(this.#db);}finally{this.#db.close();}}
}
