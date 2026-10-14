import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import {ownLegacyExportChild} from './legacy-database-export-child.ts';
import {open,realpath,link,unlink,lstat,rename} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createRequire} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';
import {dirname,join,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateLegacyDatabasePreopen,type LegacyDatabasePreopenOptions,type LegacyDatabasePreopenReceipt} from './legacy-database-preopen.ts';
import {validateLegacyRecord,splitLegacyDatabaseMetadata} from './legacy-record.ts';
import {migrateLegacyAuthorization} from './legacy-authorization-startup.ts';
const port=parentPort!,options=workerData as LegacyDatabasePreopenOptions,cancel=new AbortController();let phase='validation';
port.on('message',()=>cancel.abort(new Error('Legacy pre-open cancelled')));
const prototype='namespace_store (\n    namespace TEXT NOT NULL,\n    key TEXT NOT NULL,\n    value record NOT NULL,\n    PRIMARY KEY (namespace, key)\n)';
const lock=createRequire(import.meta.url)('../../build/sealed-file.node') as {lockDirectory(fd:number):void};
const decoder=new TextDecoder('utf-8',{fatal:true});
interface Recovery {schema:1;phase:'preparing'|'committed'|'published';database:string;source:string;sourceDev:string;sourceIno:string;sourceSha256:string;helperSha256:string;stage:string;records:number|null;transaction:string|null;}
async function readRecovery(path:string):Promise<Recovery|undefined>{
 let fd;try{fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
 try{const info=await fd.stat();if(!info.isFile()||info.nlink!==1||info.uid!==process.getuid!()||(info.mode&0o077)!==0)throw new Error('Invalid legacy recovery ownership');const bytes=Buffer.alloc(65537);let length=0;while(length<bytes.length){const result=await fd.read(bytes,length,bytes.length-length,null);if(!result.bytesRead)break;length+=result.bytesRead;}if(length>65536)throw new Error('Invalid legacy recovery bounds');const parsed:unknown=JSON.parse(decoder.decode(bytes.subarray(0,length)));if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('Invalid legacy recovery');const row=parsed as Record<string,unknown>,fields=['schema','phase','database','source','sourceDev','sourceIno','sourceSha256','helperSha256','stage','records','transaction'];if(Object.keys(row).length!==fields.length||Object.keys(row).some(k=>!fields.includes(k))||row.schema!==1||row.phase!=='preparing'&&row.phase!=='committed'&&row.phase!=='published'||row.database!==basename(options.databasePath)||row.source!==options.sourceDirectory||typeof row.sourceDev!=='string'||!/^[0-9]+$/u.test(row.sourceDev)||typeof row.sourceIno!=='string'||!/^[0-9]+$/u.test(row.sourceIno)||typeof row.sourceSha256!=='string'||!/^[a-f0-9]{64}$/u.test(row.sourceSha256)||typeof row.helperSha256!=='string'||!/^[a-f0-9]{64}$/u.test(row.helperSha256)||typeof row.stage!=='string'||!/^\.legacy-import-[a-f0-9-]{36}\.sqlite$/u.test(row.stage)||row.phase==='preparing'&&(row.records!==null||row.transaction!==null)||row.phase!=='preparing'&&(typeof row.records!=='number'||!Number.isSafeInteger(row.records)||row.records<0||row.records>1000000||typeof row.transaction!=='string'||!/^[0-9]+$/u.test(row.transaction)))throw new Error('Invalid legacy recovery schema');return row as unknown as Recovery;}finally{await fd.close();}
}
async function hash(path:string,signal:AbortSignal,max:number):Promise<string>{const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const info=await fd.stat();if(!info.isFile()||info.nlink!==1||info.size>max)throw new Error('Legacy input identity rejected');const digest=createHash('sha256');let bytes=0;for await(const chunk of fd.createReadStream({autoClose:false,signal})){bytes+=chunk.length;if(bytes>max)throw new Error('Legacy input size rejected');digest.update(chunk);}return digest.digest('hex');}finally{await fd.close();}}
async function run():Promise<LegacyDatabasePreopenReceipt>{
 validateLegacyDatabasePreopen(options);const signal=AbortSignal.any([cancel.signal,AbortSignal.timeout(120000)]);signal.throwIfAborted();
 phase='destination-open';const destination=dirname(options.databasePath);if(await realpath(destination)!==destination)throw new Error('Legacy destination must be a pinned physical directory');
 const owner=await open(destination,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
 let source:Awaited<ReturnType<typeof open>>|undefined,db:DatabaseSync|undefined,stage:string|undefined,published=false,ownedChild:ReturnType<typeof ownLegacyExportChild>|undefined,recovery:Recovery|undefined;
 const pinnedDestination='/proc/self/fd/'+owner.fd,selected=join(pinnedDestination,basename(options.databasePath));
 const journal=join(pinnedDestination,'.'+basename(options.databasePath)+'.legacy-import.json');
 const writeRecovery=async(row:Recovery,initial=false)=>{const temporary=initial?journal:journal+'.tmp-'+randomUUID(),fd=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await fd.writeFile(JSON.stringify(row)+'\n');await fd.sync();}finally{await fd.close();}if(!initial)await rename(temporary,journal);await owner.sync();recovery=row;};
 const assertDestination=async()=>{const current=await lstat(destination),pinned=await owner.stat();if(!current.isDirectory()||current.isSymbolicLink()||current.dev!==pinned.dev||current.ino!==pinned.ino)throw new Error('Legacy destination directory replaced');};
 try{
  const ownerInfo=await owner.stat();if(ownerInfo.uid!==process.getuid!()||(ownerInfo.mode&0o022)!==0)throw new Error('Legacy destination requires service ownership without public write permission');lock.lockDirectory(owner.fd);
  phase='recovery-check';recovery=await readRecovery(journal);
  let existing=false;try{const info=await lstat(selected);if(!info.isFile()||info.isSymbolicLink()||info.nlink<1||info.nlink>2||!recovery&&info.nlink!==1)throw new Error('Legacy selected database identity rejected');existing=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(recovery){
   if(recovery.phase==='preparing')throw new Error('Unconfirmed legacy import requires reconciliation');
   if(recovery.phase==='committed'){
   phase='source-open';if(await realpath(options.sourceDirectory)!==options.sourceDirectory)throw new Error('Legacy recovery source changed');source=await open(options.sourceDirectory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);const identity=await source.stat();if(String(identity.dev)!==recovery.sourceDev||String(identity.ino)!==recovery.sourceIno||await hash(join('/proc/self/fd/'+source.fd,'data.mdb'),signal,200*1024*1024)!==recovery.sourceSha256)throw new Error('Legacy recovery source changed');
   }
   stage=join(pinnedDestination,recovery.stage);let stageInfo;try{stageInfo=await lstat(stage);if(!stageInfo.isFile()||stageInfo.isSymbolicLink()||stageInfo.uid!==process.getuid!()||(stageInfo.mode&0o077)!==0)throw new Error('Legacy recovery stage identity rejected');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   if(recovery.phase==='published'&&(!existing||stageInfo||(await lstat(selected)).nlink!==1))throw new Error('Finalized legacy publication conflict');
   if(!existing&&!stageInfo)throw new Error('Legacy committed publication missing');if(existing&&stageInfo){const info=await lstat(selected);if(info.dev!==stageInfo.dev||info.ino!==stageInfo.ino||info.nlink!==2)throw new Error('Legacy recovery publication conflict');}
   const candidate=existing?selected:stage;db=new DatabaseSync(candidate,{readOnly:true});db.exec('PRAGMA trusted_schema=OFF');const rows=db.prepare('SELECT * FROM native_legacy_import').all(),row=rows[0],checks=db.prepare('PRAGMA integrity_check').all();if(rows.length!==1||!row||Object.keys(row).length!==8||row.schema!==1||row.source!==recovery.source||row.source_dev!==recovery.sourceDev||row.source_ino!==recovery.sourceIno||row.source_sha256!==recovery.sourceSha256||row.transaction_id!==recovery.transaction||row.records!==recovery.records||row.helper_sha256!==recovery.helperSha256||checks.length!==1||checks[0]!.integrity_check!=='ok')throw new Error('Legacy recovery SQLite receipt rejected');db.close();db=undefined;signal.throwIfAborted();await assertDestination();
   if(!existing){await link(stage,selected);published=true;await owner.sync();}if(stageInfo){await unlink(stage);await owner.sync();}stage=undefined;await assertDestination();if(recovery.phase!=='published')await writeRecovery({...recovery,phase:'published'});return {schema:1,mode:'existing-sqlite',records:recovery.records!,sourceSha256:recovery.sourceSha256,transaction:recovery.transaction!,helperSha256:recovery.helperSha256};
  }
  if(existing){db=new DatabaseSync(selected,{readOnly:true});db.exec('PRAGMA trusted_schema=OFF');if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='namespace_store' AND type='table'").get()||db.prepare("SELECT 1 FROM sqlite_schema WHERE name='native_legacy_import'").get())throw new Error('Existing SQLite requires reconciliation');db.close();db=undefined;await assertDestination();return {schema:1,mode:'existing-sqlite',records:0};}
  phase='source-open';if(await realpath(options.sourceDirectory)!==options.sourceDirectory)throw new Error('Legacy source must be a pinned physical directory');
  source=await open(options.sourceDirectory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);const sourceInfo=await source.stat();if(sourceInfo.uid!==process.getuid!()||(sourceInfo.mode&0o022)!==0)throw new Error('Legacy source requires service ownership without public write permission');if(sourceInfo.dev!==ownerInfo.dev||sourceInfo.ino!==ownerInfo.ino)lock.lockDirectory(source.fd);
  phase='source-hash';const sourceFile=join('/proc/self/fd/'+source.fd,'data.mdb'),sourceSha256=await hash(sourceFile,signal,200*1024*1024),helper=fileURLToPath(new URL('../../build/lmdb-read',import.meta.url)),helperSha256=await hash(helper,signal,16*1024*1024);
  phase='stage-allocation';stage=join(pinnedDestination,'.legacy-import-'+randomUUID()+'.sqlite');const allocated=await open(stage,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);await allocated.close();
  await writeRecovery({schema:1,phase:'preparing',database:basename(options.databasePath),source:options.sourceDirectory,sourceDev:String(sourceInfo.dev),sourceIno:String(sourceInfo.ino),sourceSha256,helperSha256,stage:basename(stage),records:null,transaction:null},true);
  phase='stage-schema';db=new DatabaseSync(stage);db.exec('PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA max_page_count=65536');db.exec(`CREATE TABLE ${prototype}; CREATE TABLE table_registry(name TEXT NOT NULL PRIMARY KEY, prototype TEXT NOT NULL, version INT);`);db.prepare('INSERT INTO table_registry VALUES(?,?,?)').run('namespace_store',prototype,1);
  phase='helper-spawn';const child=spawn(helper,[],{stdio:['ignore','pipe','pipe',source.fd],env:{LANG:'C'}}),owned=ownLegacyExportChild(child,({code,signal})=>{if(child.pid)port.postMessage({process:{event:'closed',pid:child.pid,status:code,signal}});});let diagnosticBytes=0;
  ownedChild=owned;
  child.stderr!.on('data',bytes=>{diagnosticBytes+=bytes.length;if(diagnosticBytes>65536)void owned.stop().catch(()=>{});});
  if(child.pid)port.postMessage({process:{event:'started',pid:child.pid}});
  const abort=()=>{void owned.stop().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  const iterator=child.stdout![Symbol.asyncIterator]();let buffer=Buffer.alloc(0),outputBytes=0;
  const read=async(size:number)=>{const parts:Buffer[]=[];let left=size;while(left){signal.throwIfAborted();if(!buffer.length){const next=await iterator.next();if(next.done)throw new Error('Incomplete legacy snapshot');buffer=Buffer.from(next.value);outputBytes+=buffer.length;if(outputBytes>256*1024*1024+40)throw new Error('Legacy snapshot exceeds capacity');}const take=Math.min(left,buffer.length);parts.push(buffer.subarray(0,take));buffer=buffer.subarray(take);left-=take;}return Buffer.concat(parts,size);};
  const number=async()=>{const value=(await read(8)).readBigUInt64BE();if(value>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('Invalid legacy snapshot length');return Number(value);};
  phase='records-import';let records=0,transaction='';db.exec('BEGIN IMMEDIATE');
  try{
   if((await read(8)).toString()!=='ANYLMDB1')throw new Error('Invalid legacy snapshot header');transaction=(await read(8)).readBigUInt64BE().toString();const insert=db.prepare('INSERT INTO namespace_store VALUES(?,?,?)');
   for(;;){const nl=await number(),kl=await number(),vl=await number();if(nl===0){if(kl!==records||vl>100)throw new Error('Invalid legacy snapshot trailer');break;}if(nl>1024||!kl||kl>1024||!vl||vl>1024*1024||++records>1000000)throw new Error('Invalid legacy snapshot record bounds');const namespace=decoder.decode(await read(nl)),key=decoder.decode(await read(kl)),value=await read(vl);if(!namespace||namespace.includes('\0')||key.includes('\0'))throw new Error('Invalid legacy snapshot key');validateLegacyRecord(value);
    if(namespace==='moonraker'&&key==='database'){const metadata=splitLegacyDatabaseMetadata(value);if(metadata){for(const entry of metadata)insert.run('database',entry.key,entry.value);continue;}}
    insert.run(namespace==='moonraker'&&key==='database_version'?'database':namespace,key,value);
   }
   if(buffer.length)throw new Error('Trailing legacy snapshot bytes');const remainder=await iterator.next();if(!remainder.done)throw new Error('Trailing legacy snapshot bytes');const end=await owned.closed;if(owned.spawnError||owned.observationError||end.code!==0||end.signal||diagnosticBytes>65536)throw new Error('Legacy snapshot helper failed');signal.throwIfAborted();
   if(await hash(sourceFile,signal,200*1024*1024)!==sourceSha256)throw new Error('Legacy source changed during migration');
   db.exec('CREATE TABLE native_legacy_import(schema INTEGER NOT NULL, source TEXT NOT NULL, source_dev TEXT NOT NULL, source_ino TEXT NOT NULL, source_sha256 TEXT NOT NULL, transaction_id TEXT NOT NULL, records INTEGER NOT NULL, helper_sha256 TEXT NOT NULL)');db.prepare('INSERT INTO native_legacy_import VALUES(?,?,?,?,?,?,?,?)').run(1,options.sourceDirectory,String(sourceInfo.dev),String(sourceInfo.ino),sourceSha256,transaction,records,helperSha256);db.exec('COMMIT');
  }catch(error){await owned.stop();try{db.exec('ROLLBACK');}catch{}throw error;}finally{signal.removeEventListener('abort',abort);}
  phase='identity-import';migrateLegacyAuthorization(db,options.authorization,1024*1024);const checks=db.prepare('PRAGMA integrity_check').all();if(checks.length!==1||checks[0]!.integrity_check!=='ok')throw new Error('Legacy SQLite integrity rejected');db.close();db=undefined;signal.throwIfAborted();
  const finished=await open(stage,constants.O_RDONLY|constants.O_NOFOLLOW);try{await finished.sync();}finally{await finished.close();}
  phase='publication';await writeRecovery({...recovery!,phase:'committed',records,transaction});signal.throwIfAborted();
  // link is exclusive publication: an existing selected database is never
  // overwritten. The source and original LMDB are retained for recovery.
  await assertDestination();await link(stage,selected);published=true;await owner.sync();await unlink(stage);stage=undefined;await owner.sync();await assertDestination();await writeRecovery({...recovery!,phase:'published'});
  return {schema:1,mode:'imported-lmdb',records,sourceSha256,transaction,helperSha256};
 }finally{
  try{await ownedChild?.stop();}finally{
   try{db?.close();}finally{
    try{if(stage&&!published&&!recovery){await unlink(stage).catch(()=>{});await unlink(stage+'-journal').catch(()=>{});}}finally{
     try{await source?.close();}finally{await owner.close();}
    }
   }
  }
 }
}
try{port.postMessage({receipt:await run()});}catch{port.postMessage({error:'Legacy database pre-open failed at '+phase+'; retained source requires administrator reconciliation'});}finally{port.close();}
