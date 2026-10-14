// Startup-only import from pinned Moonraker authorization.py. GPL-3.0-or-later.
import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {ApiError,type Json} from './rpc.ts';
import {decodeDatabaseRecord,encodeDatabaseRecord} from './database-record.ts';
import {parseRequestJson} from './json.ts';

/** Trusted profile declaration. No endpoint accepts this capability. */
export interface LegacyAuthorizationStartup {issuer:string;legacyIssuer?:string;legacyNamespaceBackupSha256?:string;}
interface ImportedUser {username:string;password:string;salt:string;created_on:number;source:'moonraker'|'ldap';jwt_secret:string|null;jwk_id:string|null;groups:string[]|null;}
const privateNamespaces=['native_authorization','native_users','authorized_users','native_identity_migration'];
const invalid=()=>new ApiError(422,'Legacy authorization startup requires administrator reconciliation');
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
/** Exact byte framing for a trusted backup authorization. Order is SQLite's
 * selected key order; no record boundary can be manufactured inside a value. */
export function legacyNamespaceBackupDigest(records:Iterable<{key:Uint8Array;value:Uint8Array}>):string{
 const digest=createHash('sha256').update('ANYRAID legacy namespace backup v1\0authorized_users\0');let count=0;
 for(const record of records){if(++count>129||record.key.byteLength>1024||record.value.byteLength>1024*1024)throw invalid();const lengths=Buffer.alloc(16);lengths.writeBigUInt64BE(BigInt(record.key.byteLength),0);lengths.writeBigUInt64BE(BigInt(record.value.byteLength),8);digest.update(lengths);digest.update(record.key);digest.update(record.value);}
 const end=Buffer.alloc(8);end.writeBigUInt64BE(BigInt(count));digest.update(end);return digest.digest('hex');
}
export function validateLegacyAuthorizationStartup(options:LegacyAuthorizationStartup):void{
 if(!options||Object.keys(options).some(k=>!['issuer','legacyIssuer','legacyNamespaceBackupSha256'].includes(k)))throw invalid();
 if(options.legacyNamespaceBackupSha256!==undefined&&!/^[a-f0-9]{64}$/.test(options.legacyNamespaceBackupSha256))throw invalid();
 for(const value of [options.issuer,...options.legacyIssuer===undefined?[]:[options.legacyIssuer]]){
  if(typeof value!=='string'||Buffer.byteLength(value)>2048)throw invalid();let url:URL;try{url=new URL(value);}catch{throw invalid();}if(!['http:','https:'].includes(url.protocol)||url.origin!==value||url.username||url.password)throw invalid();
 }
}
function usersEqual(a:ImportedUser[],b:ImportedUser[]):boolean{const byName=(rows:ImportedUser[])=>[...rows].sort((x,y)=>x.username<y.username?-1:x.username>y.username?1:0);return JSON.stringify(byName(a))===JSON.stringify(byName(b));}
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw invalid();return value as Record<string,unknown>;}
function user(value:unknown,name:string):ImportedUser{
 const supplied=object(value),row:Record<string,unknown>={...supplied,created_on:Object.hasOwn(supplied,'created_on')?supplied.created_on:Date.now()/1000,salt:Object.hasOwn(supplied,'salt')?supplied.salt:'',source:Object.hasOwn(supplied,'source')?supplied.source:'moonraker',groups:Object.hasOwn(supplied,'groups')?supplied.groups:['admin']},allowed=['username','password','salt','created_on','source','jwt_secret','jwk_id','groups'];if(Object.keys(row).some(k=>!allowed.includes(k))||row.username!==undefined&&row.username!==name||!name||!name.isWellFormed()||Buffer.byteLength(name)>256||name.includes('\0')||['_API_KEY_USER_','_TRUSTED_USER_'].includes(name))throw invalid();
 const source=row.source,jwt=row.jwt_secret??null,kid=row.jwk_id??null,groups=row.groups;
 if(source!=='moonraker'&&source!=='ldap'||typeof row.created_on!=='number'||!Number.isFinite(row.created_on)||row.created_on<0||typeof row.password!=='string'||typeof row.salt!=='string'||source==='moonraker'&&(!/^[a-f0-9]{64}$/.test(row.password)||!/^(?:[a-f0-9]{64})?$/.test(row.salt))||source==='ldap'&&(row.password!==''||row.salt!=='')||(jwt===null)!==(kid===null)||jwt!==null&&(typeof jwt!=='string'||!/^[a-f0-9]{64}$/.test(jwt)||typeof kid!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(kid))||groups!==null&&(!Array.isArray(groups)||groups.length>256||groups.some(g=>typeof g!=='string'||!g.isWellFormed()||Buffer.byteLength(g)>1024||g.includes('\0'))))throw invalid();
 return {username:name,password:row.password,salt:row.salt,created_on:row.created_on,source,jwt_secret:jwt as string|null,jwk_id:kid as string|null,groups:groups as string[]|null};
}
/** The caller owns startup and has not sent Worker ready. Both private stores,
 * namespace access policy and receipt commit in ONE transaction. Source rows
 * are never deleted; this is not a general SQL or HTTP migration facility. */
export function migrateLegacyAuthorization(db:DatabaseSync,options:LegacyAuthorizationStartup,maxRecordBytes:number):void{
 validateLegacyAuthorizationStartup(options);
 const get=(namespace:string,key:string):Json|undefined=>{const row=db.prepare('SELECT value FROM namespace_store WHERE namespace=? AND key=?').get(namespace,key);if(!row)return;const value=row.value;if(!(value instanceof Uint8Array)||value.byteLength>maxRecordBytes)throw invalid();return decodeDatabaseRecord(value);};
 const put=(namespace:string,key:string,value:Json)=>{const bytes=encodeDatabaseRecord(value);if(bytes.length>maxRecordBytes)throw invalid();db.prepare('INSERT INTO namespace_store VALUES(?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value').run(namespace,key,bytes);};
 db.exec('BEGIN IMMEDIATE');
 try{
  const completed=get('native_identity_migration','receipt');
  if(completed!==undefined){const receipt=object(completed),fields=['schema','phase','source','issuer','legacyIssuer','legacyNamespaceBackupSha256','users','sourceSha256'];if(Object.keys(receipt).length!==fields.length||Object.keys(receipt).some(k=>!fields.includes(k))||receipt.schema!==1||receipt.phase!=='committed'||typeof receipt.source!=='string'||!['sql','namespace'].includes(receipt.source)||receipt.issuer!==options.issuer||receipt.legacyIssuer!==(options.legacyIssuer??null)||receipt.legacyNamespaceBackupSha256!==(options.legacyNamespaceBackupSha256??null)||typeof receipt.users!=='number'||!Number.isSafeInteger(receipt.users)||receipt.users<0||receipt.users>128||typeof receipt.sourceSha256!=='string'||!/^[a-f0-9]{64}$/.test(receipt.sourceSha256))throw invalid();const key=get('native_authorization','api_key'),users=get('native_users','users');if(typeof key!=='string'||!/^[a-f0-9]{32}$/.test(key)||!Array.isArray(users)||users.length>128)throw invalid();const names=new Set<string>();for(const row of users){const value=object(row);if(typeof value.username!=='string'||names.has(value.username))throw invalid();user(row,value.username);names.add(value.username);}}
  else{
   const sql=!!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='authorized_users'").get();let records:{name:string;row:Record<string,unknown>}[]=[],source:'sql'|'namespace';
   if(sql){
    source='sql';const columns=db.prepare('PRAGMA table_xinfo(authorized_users)').all(),names=['username','password','created_on','salt','source','jwt_secret','jwk_id','groups'];const types=['TEXT','TEXT','REAL','TEXT','TEXT','TEXT','TEXT','pyjson'],notnull=[1,1,1,1,1,0,0,0];if(columns.length!==8||columns.some((r,i)=>r.name!==names[i]||r.type!==types[i]||r.notnull!==notnull[i]||r.pk!==(i===0?1:0)||r.dflt_value!==null||r.hidden!==0))throw invalid();
    const registry=db.prepare("SELECT prototype,version FROM table_registry WHERE name='authorized_users'").get();const expected='authorized_users ( username TEXT PRIMARY KEY NOT NULL, password TEXT NOT NULL, created_on REAL NOT NULL, salt TEXT NOT NULL, source TEXT NOT NULL, jwt_secret TEXT, jwk_id TEXT, groups pyjson )';if(registry?.version!==1||typeof registry.prototype!=='string'||registry.prototype.replace(/\s+/gu,' ').trim()!==expected)throw invalid();
    // A completed SQL table is authoritative. Old data.mdb is not a contender.
    for(const row of db.prepare('SELECT * FROM authorized_users ORDER BY username').iterate()){if(records.length>=129||typeof row.username!=='string')throw invalid();let groups:unknown=row.groups;if(groups!==null){if(typeof groups!=='string'||Buffer.byteLength(groups)>65536)throw invalid();groups=parseRequestJson(groups);}records.push({name:row.username,row:{...row,groups}});}
   }else{
    source='namespace';for(const row of db.prepare("SELECT key,value FROM namespace_store WHERE namespace='authorized_users' ORDER BY key").iterate()){if(records.length>=129||typeof row.key!=='string'||!(row.value instanceof Uint8Array)||row.value.length>maxRecordBytes)throw invalid();records.push({name:row.key,row:object(decodeDatabaseRecord(row.value))});}
   }
   const api=records.find(r=>r.name==='_API_KEY_USER_');if(!api)throw invalid();const key=source==='sql'?api.row.password:api.row.api_key;if(typeof key!=='string'||!/^[a-f0-9]{32}$/.test(key))throw invalid();
   const users=records.filter(r=>r!==api).map(r=>user(r.row,r.name));if(new Set(users.map(r=>r.username)).size!==users.length)throw invalid();
   if(source==='sql'){
    const legacy:{name:string;row:Record<string,unknown>}[]=[],bytes:{key:Uint8Array;value:Uint8Array}[]=[];for(const row of db.prepare("SELECT key,value FROM namespace_store WHERE namespace='authorized_users' ORDER BY key").iterate()){if(legacy.length>=129||typeof row.key!=='string'||!(row.value instanceof Uint8Array)||row.value.byteLength>maxRecordBytes)throw invalid();bytes.push({key:Buffer.from(row.key),value:row.value});legacy.push({name:row.key,row:object(decodeDatabaseRecord(row.value))});}
    if(legacy.length){const approved=options.legacyNamespaceBackupSha256;if(approved!==undefined){if(legacyNamespaceBackupDigest(bytes)!==approved)throw invalid();}else{const api=legacy.find(r=>r.name==='_API_KEY_USER_'),oldUsers=legacy.filter(r=>r!==api).map(r=>user({...r.row,...!Object.hasOwn(r.row,'created_on')?{created_on:users.find(u=>u.username===r.name)?.created_on}:{}},r.name));if(api?.row.api_key!==key||!usersEqual(oldUsers,users))throw invalid();}}
   }
   const savedKey=get('native_authorization','api_key'),savedUsers=get('native_users','users');if(savedKey!==undefined&&savedKey!==key||savedUsers!==undefined&&(!Array.isArray(savedUsers)||!usersEqual(savedUsers.map(v=>{const row=object(v);if(typeof row.username!=='string')throw invalid();return user(v,row.username);}),users)))throw invalid();
   put('native_authorization','api_key',key);put('native_users','users',users as unknown as Json);
   put('native_identity_migration','receipt',{schema:1,phase:'committed',source,issuer:options.issuer,legacyIssuer:options.legacyIssuer??null,legacyNamespaceBackupSha256:options.legacyNamespaceBackupSha256??null,users:users.length,sourceSha256:hash(encodeDatabaseRecord(records as unknown as Json))});
  }
  const policy=get('database','forbidden_namespaces');if(policy!==undefined&&(!Array.isArray(policy)||policy.some(n=>typeof n!=='string')))throw invalid();put('database','forbidden_namespaces',[...new Set(['database',...(policy as string[]??[]),...privateNamespaces])].sort());
  db.exec('COMMIT');
 }catch{try{db.exec('ROLLBACK');}catch{}throw invalid();}
}
