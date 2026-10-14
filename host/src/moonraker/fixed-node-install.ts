import {constants} from 'node:fs';
import {open,lstat,mkdir,rename,unlink} from 'node:fs/promises';
import {join,dirname,resolve,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {ApiError,authorizedContext,type Json,type RpcContext} from './rpc.ts';
import type {ConfigurationReader} from './config-reader.ts';
import {loadConfiguration} from './config-source.ts';
import {LegacyConfigCommitOwner} from './legacy-config-commit.ts';
import type {NativeConfigFiles} from './native-config-files.ts';
import type {DatabaseStore} from './database.ts';
import type {ProcessSudoOwner,SudoConsumerResult} from './sudo-owner.ts';
import type {LegacyNodeInstallDeclaration} from './legacy-node-install.ts';

export interface FixedNodeInstallOptions {
 dataPath:string;configRoot:string;configFile:string;databasePath:string;logsRoot:string;gcodesRoot:string;
 unit:string;candidateSha256:string;recoveryPath:string;
 /** Factory-produced pre-open proof; selects the actual legacy consumer. */
 legacy?:LegacyNodeInstallDeclaration;
}
type InstallState='checking'|'pending'|'running'|'restart_required'|'ready'|'blocked';
interface InstallJournal {schema:1;unit:string;candidateSha256:string;configBefore:string;configAfter:string;phase:'planned'|'service-started'|'service-confirmed'|'config-started'|'config-confirmed'|'version-confirmed';user:string;}
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
async function boundedFile(path:string,max=4*1024*1024):Promise<Buffer>{const file=await open(path,constants.O_RDONLY|constants.O_NONBLOCK|constants.O_NOFOLLOW);try{const s=await file.stat();if(!s.isFile()||s.size>max)throw new ApiError(409,'Unsupported fixed installation input');const chunks:Buffer[]=[];let n=0;for(;;){const b=Buffer.alloc(Math.min(65536,max+1-n)),r=await file.read(b);if(!r.bytesRead)break;n+=r.bytesRead;if(n>max)throw new ApiError(413,'Installation input exceeded capacity');chunks.push(b.subarray(0,r.bytesRead));}return Buffer.concat(chunks);}finally{await file.close();}}
async function journal(path:string,value:InstallJournal):Promise<void>{const tmp=join(dirname(path),'.install-'+randomUUID()),file=await open(tmp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);let moved=false;try{await file.writeFile(JSON.stringify(value)+'\n');await file.sync();await file.close();await rename(tmp,path);moved=true;const parent=await open(dirname(path),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await parent.sync();}finally{await parent.close();}}finally{await file.close().catch(()=>{});if(!moved)await unlink(tmp).catch(()=>{});}}
export class InstallReadinessError extends ApiError {readonly state:InstallState;constructor(state:InstallState){super(503,'Fixed Node installation validation blocks device acquisition');this.state=state;}}
/** Actual installation queue consumer for an already fixed Node layout.
 * Legacy relocation/LMDB conversion never runs after these process files open. */
export class FixedNodeInstallValidator {
 readonly #configurationCommit:LegacyConfigCommitOwner;readonly #options:Readonly<FixedNodeInstallOptions>;readonly #reader:ConfigurationReader;readonly #files:NativeConfigFiles;readonly #db:DatabaseStore;readonly #sudo:ProcessSudoOwner;readonly #confirmed:()=>Promise<void>;
 #state:InstallState='checking';#before:Buffer|undefined;#after:Buffer|undefined;#pending:Promise<unknown>|undefined;#release=()=>{};#reason='Installation validation not completed';
 constructor(options:FixedNodeInstallOptions,reader:ConfigurationReader,files:NativeConfigFiles,db:DatabaseStore,sudo:ProcessSudoOwner,confirmed:()=>Promise<void>=async()=>{}){this.#options=Object.freeze({...options});this.#configurationCommit=new LegacyConfigCommitOwner(options.recoveryPath+'.config-batch.json');this.#reader=reader;this.#files=files;this.#db=db;this.#sudo=sudo;this.#confirmed=confirmed;}
 get status(){return {state:this.#state,ready:this.#state==='ready',restart_required:this.#state==='restart_required',running:this.#state==='running',message:this.#reason};}
 assertReady(){if(this.#state!=='ready')throw new InstallReadinessError(this.#state);}
 #blocked(){this.#state='blocked';this.#reason='Fixed Node layout or installation outcome requires administrator reconciliation';}
 async initialize(signal:AbortSignal):Promise<void>{
  try{
   const o=this.#options;for(const p of [o.dataPath,o.configRoot,o.configFile,o.databasePath,o.logsRoot,o.gcodesRoot,o.recoveryPath]){if(!isAbsolute(p)||resolve(p)!==p||/[\0\r\n]/u.test(p)||p==='/')throw Error();}
   if(o.configRoot!==join(o.dataPath,'config')||o.configFile!==join(o.configRoot,'moonraker.conf')||o.databasePath!==join(o.dataPath,'database/moonraker-sql.db')||o.logsRoot!==join(o.dataPath,'logs')||o.gcodesRoot!==join(o.dataPath,'gcodes')||dirname(o.recoveryPath)!==join(o.dataPath,'systemd')||!this.#files.contains(o.configFile)||this.#db.storagePaths.path!==o.databasePath||!/^[a-f0-9]{64}$/u.test(o.candidateSha256)||!/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,239}\.service$/u.test(o.unit))throw Error();
   for(const p of [o.dataPath,o.configRoot,dirname(o.databasePath),o.logsRoot,o.gcodesRoot]){const s=await lstat(p);if(!s.isDirectory()||s.isSymbolicLink())throw Error();}
   // Primary-file-only mutation. Includes may remain read-only, but a target
   // section shared with an include or DEFAULT inheritance is rejected.
   const targets=new Map<string,string|null>([['database.database_path',dirname(o.databasePath)],['server.config_path',o.configRoot],['file_manager.config_path',o.configRoot],['server.log_path',o.logsRoot],['file_manager.log_path',o.logsRoot],['secrets.secrets_path',join(o.dataPath,'moonraker.secrets')],['server.ssl_certificate_path',join(o.dataPath,'certs/moonraker.cert')],['server.ssl_key_path',join(o.dataPath,'certs/moonraker.key')],['server.enable_debug_logging',null],['update_manager.enable_repo_debug',null]]);
   const source=await loadConfiguration(o.configFile);if(JSON.stringify(source.original)!==JSON.stringify(this.#reader.source.original)||JSON.stringify(source.files)!==JSON.stringify(this.#reader.source.files))throw Error('Loaded process source differs from current config');this.#before=await boundedFile(o.configFile);let text=new TextDecoder('utf-8',{fatal:true}).decode(this.#before),section='',skip=false;const output:string[]=[];
   for(const [key,target]of targets){const at=key.indexOf('.'),s=key.slice(0,at),option=key.slice(at+1),value=source.original[s]?.[option];if(value===undefined)continue;if(Object.hasOwn(source.original.DEFAULT??{},option)||source.files.filter(f=>f.sections.includes(s)).some(f=>f.filename!==o.configFile)||!source.files.find(f=>f.filename===o.configFile)?.sections.includes(s))throw Error();if(target!==null&&resolve(value)!==target)throw Error();}
   for(const line of text.split(/(?<=\n)/)){const trimmed=line.trim(),header=trimmed.match(/^\[([^\]]+)\]/u);if(header){section=header[1];skip=false;output.push(line);continue;}const option=line.match(/^\s*([^\s#;][^:=]*?)\s*[:=]/u);if(option){skip=targets.has(section+'.'+option[1].trim().toLowerCase());if(skip)continue;}else if(skip&&/^\s+\S/u.test(line))continue;else if(trimmed&&!trimmed.startsWith('#')&&!trimmed.startsWith(';'))skip=false;output.push(line);}
   this.#after=Buffer.from(output.join(''));signal.throwIfAborted();
   const preview=join(o.configRoot,'.node-install-preview-'+randomUUID()),f=await open(preview,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await f.writeFile(this.#after);await f.close();const candidate=await loadConfiguration(preview),expected=structuredClone(source.original);for(const key of targets.keys()){const at=key.indexOf('.');if(expected[key.slice(0,at)])delete expected[key.slice(0,at)][key.slice(at+1)];}if(JSON.stringify(candidate.original)!==JSON.stringify(expected)||JSON.stringify(candidate.files.map(p=>({...p,filename:p.filename===preview?o.configFile:p.filename})))!==JSON.stringify(source.files))throw Error('Candidate changes unapproved configuration values or includes');}finally{await f.close().catch(()=>{});await unlink(preview);}
   // A legacy gcode path still requires real pre-open migration, even if other
   // old path aliases happen to match. Never delete it or mark legacy complete.
   try{await this.#db.get('moonraker','file_manager.gcode_path');throw Error('Legacy gcode path remains');}catch(e){if(!(e instanceof ApiError&&e.status===404))throw e;}
   // This fixed-layout consumer does not inspect/migrate every namespace or SQL
   // table. Existing record codec precision boundaries remain unchanged.
   const configurationPhase=await this.#configurationCommit.inspect([o.configFile],o.candidateSha256,signal);
   let previous:InstallJournal|undefined;try{previous=JSON.parse((await boundedFile(o.recoveryPath,65536)).toString()) as InstallJournal;if(previous.schema!==1||Object.keys(previous).some(k=>!['schema','unit','candidateSha256','configBefore','configAfter','phase','user'].includes(k))||previous.unit!==o.unit||previous.candidateSha256!==o.candidateSha256||!['planned','version-confirmed'].includes(previous.phase)||![previous.configBefore,previous.configAfter].every(h=>typeof h==='string'&&/^[a-f0-9]{64}$/u.test(h)))throw Error('Unknown installation journal');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
   let marker:Json|null=null;try{marker=await this.#db.get('moonraker','validate_install.node_layout');}catch(e){if(!(e instanceof ApiError&&e.status===404))throw e;}
   if(marker&&!previous)throw Error('Version marker has no confirmed recovery journal');
   // Old fixed-layout installs predate this batch owner. Only an absent batch
   // record can use their existing confirmed single-file journal/marker proof;
   // a present planned record is never a completion proof.
   let rootStatus;try{rootStatus=await this.#sudo.operation('status',signal);}catch{signal.throwIfAborted();/* An authenticated password request may acquire status later. */}
   if(rootStatus&&rootStatus.candidateSha256!==o.candidateSha256||rootStatus?.phase==='unknown'&&rootStatus.backup!==null)throw Error('Privileged outcome requires reconciliation');
   if(marker&&typeof marker==='object'&&!Array.isArray(marker)&&marker.version===1&&marker.candidate_sha256===o.candidateSha256&&marker.config_sha256===hash(this.#before)&&hash(this.#before)===hash(this.#after)&&previous?.phase==='version-confirmed'&&(configurationPhase==='confirmed'||configurationPhase==='absent')&&previous.configAfter===hash(this.#before)&&rootStatus?.phase==='installed'&&rootStatus.unitSha256===o.candidateSha256){this.#state='ready';this.#reason='Fixed Node installation revalidated in this process';return;}
   this.#state='pending';this.#reason='Sudo password required for fixed Node installation validation';this.#release=this.#sudo.register('fixed-node-install',this.#reason,c=>this.#install(c));
  }catch{this.#blocked();}
 }
 #install(context:RpcContext):Promise<SudoConsumerResult>{
  if(this.#pending)return Promise.reject(new ApiError(409,'Installation already running'));if(this.#state!=='pending')return Promise.reject(new ApiError(409,this.#reason));this.#state='running';
  let sideEffects=false;const task=(async()=>{
   let bound=authorizedContext(context,await context.authorize('machine.sudo.password',{}));const o=this.#options,record:InstallJournal={schema:1,unit:o.unit,candidateSha256:o.candidateSha256,configBefore:hash(this.#before!),configAfter:hash(this.#after!),phase:'planned',user:bound.user?.username??'authorized'};
   const latest=await loadConfiguration(o.configFile);if(JSON.stringify(latest.original)!==JSON.stringify(this.#reader.source.original)||JSON.stringify(latest.files)!==JSON.stringify(this.#reader.source.files)||hash(await boundedFile(o.configFile))!==record.configBefore)throw new ApiError(409,'Installation source changed before admission');
   await mkdir(dirname(o.recoveryPath),{recursive:true,mode:0o700});await journal(o.recoveryPath,record);
   const edits=record.configBefore===record.configAfter?[]:[{filename:o.configFile,sourceFilename:o.configFile,before:this.#before!,after:this.#after!,beforeSha256:record.configBefore,afterSha256:record.configAfter,removed:[],materialized:[]}];
   return this.#files.installationBatchTransaction(edits.map(e=>({filename:e.filename,bytes:e.after,expected:e.beforeSha256})),bound,async(signal,commit)=>{
    await this.#configurationCommit.plan(edits,o.candidateSha256,signal);
    bound=authorizedContext(bound,await bound.authorize('machine.sudo.password',{}));signal.throwIfAborted();record.phase='service-started';await journal(o.recoveryPath,record);sideEffects=true;
    const receipt=await this.#sudo.operation('install',signal);if(receipt.phase!=='installed'||receipt.candidateSha256!==o.candidateSha256||receipt.unitSha256!==o.candidateSha256)throw Error('Privileged installation not confirmed');record.phase='service-confirmed';await journal(o.recoveryPath,record);
    if(record.configBefore!==record.configAfter){record.phase='config-started';await journal(o.recoveryPath,record);await this.#configurationCommit.commitAll(commit,signal);if(hash(await boundedFile(o.configFile))!==record.configAfter)throw Error('Configuration confirmation failed');}
    if(!edits.length)await this.#configurationCommit.commitAll(commit,signal);
    record.phase='config-confirmed';await journal(o.recoveryPath,record);bound=authorizedContext(bound,await bound.authorize('machine.sudo.password',{}));signal.throwIfAborted();
    // Separate Node marker; never overwrite upstream install_version and claim
    // that unsupported legacy directory/LMDB migration has completed.
    await this.#db.insert('moonraker','validate_install.node_layout',{version:1,candidate_sha256:o.candidateSha256,config_sha256:record.configAfter});record.phase='version-confirmed';await journal(o.recoveryPath,record);
    this.#state='restart_required';this.#reason='Installation confirmed; fresh process required before device acquisition';await this.#confirmed();return {message:'Fixed Node installation complete; process restart required.',restart:true};
   });
  })();this.#pending=task;return task.catch(e=>{if(sideEffects)this.#blocked();else{this.#state='pending';this.#reason='Installation admission failed before privileged/config effects; explicit retry permitted';}throw e;}).finally(()=>{this.#pending=undefined;});
 }
 async close(){this.#release();const results=await Promise.allSettled([this.#pending]);try{await this.#configurationCommit.close();}catch(error){results.push({status:'rejected',reason:error});}finally{this.#before?.fill(0);this.#after?.fill(0);}const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length)throw new AggregateError(errors,'Installation validator close failed');}
 async requestRestart(signal:AbortSignal):Promise<void>{if(this.#state!=='restart_required'&&this.#state!=='ready')throw new ApiError(409,'Confirmed installation restart unavailable');await this.#sudo.operation('restart',signal);}
}
