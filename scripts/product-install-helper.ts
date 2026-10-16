// Administrator-installed standalone helper. Only Node built-ins may be imported:
// no bundle/profile/module code is ever loaded with elevated privileges.
import {constants} from 'node:fs';
import {open,lstat,realpath,mkdir,rename,unlink,readFile,readdir,chmod} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {dirname,join,isAbsolute,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export interface FixedInstallManifest {
 schema:1;unit:string;user:string;node:string;bundle:string;profile:string;dataPath:string;
 profileSha256:string;bundleManifestSha256:string;candidateSha256:string;previousUnitSha256:string;
}
export interface FixedInstallReceipt {schema:1;phase:'ready'|'installed'|'unknown';candidateSha256:string;unitSha256:string|null;backup:string|null;envBackup:string|null;}
export interface FixedInstallFixture {
 /** Tests only: isolated filesystem root and fixed fake systemctl executor.
  * The CLI never accepts either value or an environment switch for this mode. */
 root:string;command(args:readonly string[]):Promise<void>;
 afterLock?():Promise<void>;
}
/** Ordinary-user preparation only: bounded data reads and stdout JSON. Never
 * imports a profile, installs a service, creates policy or executes root code. */
export async function prepareFixedInstallManifest(requestPath:string):Promise<FixedInstallManifest>{
 const value=JSON.parse((await readBounded(requestPath)).toString());if(!value||Object.keys(value).some(k=>!['schema','unit','user','node','bundle','profile','dataPath'].includes(k)))throw Error('Invalid installation preparation request');
 const m:FixedInstallManifest={...value,profileSha256:'0'.repeat(64),bundleManifestSha256:'0'.repeat(64),candidateSha256:'0'.repeat(64),previousUnitSha256:'0'.repeat(64)};validateManifest(m);
 m.profileSha256=digest(await readBounded(m.profile,1024*1024));m.bundleManifestSha256=digest(await readBounded(join(m.bundle,'build-info.json'),4*1024*1024));m.previousUnitSha256=digest(await readBounded('/etc/systemd/system/'+m.unit));m.candidateSha256=digest(Buffer.from(fixedInstallUnit(m)));return m;
}
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function path(value:unknown):asserts value is string {if(typeof value!=='string'||!isAbsolute(value)||resolve(value)!==value||/[\x00-\x1f\x7f]/u.test(value)||Buffer.byteLength(value)>4096)throw Error('Invalid fixed installation path');}
function quote(value:string,command=false):string{return '"'+value.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%').replaceAll('$',command?'$$':'$')+'"';}
export function fixedInstallUnit(m:FixedInstallManifest):string {
 validateManifest(m);
 return `[Unit]\nDescription=ANYRAID Node product host\nAfter=network.target\nConflicts=${['klipper.service','moonraker.service'].filter(u=>u!==m.unit).join(' ')}\n\n[Service]\nType=exec\nUser=${m.user}\nWorkingDirectory=/\nExecStartPre=${quote(m.node,true)} --no-experimental-strip-types ${quote(join(m.bundle,'scripts/product-service-unit.js'),true)} --verify-bundle ${quote(m.bundle,true)}\nExecStart=${quote(m.node,true)} --no-experimental-strip-types ${quote(join(m.bundle,'scripts/product-host.js'),true)} --profile ${quote(m.profile,true)}\nRestart=no\nKillSignal=SIGTERM\nKillMode=mixed\nTimeoutStopSec=90s\nUMask=0077\nStandardOutput=journal\nStandardError=journal\n\n[Install]\nWantedBy=multi-user.target\n`;
}
function validateManifest(m:FixedInstallManifest):void{
 if(!m||m.schema!==1||Object.keys(m).some(k=>!['schema','unit','user','node','bundle','profile','dataPath','profileSha256','bundleManifestSha256','candidateSha256','previousUnitSha256'].includes(k))||!/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,239}\.service$/u.test(m.unit)||!/^[a-z_][a-z0-9_-]{0,30}$/u.test(m.user)||m.user==='root')throw Error('Invalid fixed installation manifest');
 for(const p of [m.node,m.bundle,m.profile,m.dataPath])path(p);
 for(const h of [m.profileSha256,m.bundleManifestSha256,m.candidateSha256,m.previousUnitSha256])if(!/^[a-f0-9]{64}$/u.test(h))throw Error('Invalid fixed installation digest');
 if(m.bundle===m.profile||m.profile.startsWith(m.bundle+'/')||m.node.startsWith(m.bundle+'/'))throw Error('Profile and runtime must be outside the bundle');
}
/** Parent checks are also required BEFORE sudo starts Node/helper: checks here
 * cannot repair a substituted executable that has already started as root. */
export async function assertRootPath(filename:string,executable=false,directory=false):Promise<void>{
 path(filename);let current=filename,first=true;
 for(;;){const s=await lstat(current);if(s.isSymbolicLink()||s.uid!==0||(s.mode&0o022)!==0||first&&(directory?!s.isDirectory():!s.isFile()||executable&&(s.mode&0o111)===0)||!first&&!s.isDirectory())throw Error('Untrusted administrator installation path');if(current==='/')break;current=dirname(current);first=false;}
}
async function readBounded(filename:string,max=65536):Promise<Buffer>{
 const f=await open(filename,constants.O_RDONLY|constants.O_NONBLOCK|constants.O_NOFOLLOW);try{const s=await f.stat();if(!s.isFile()||s.size>max||s.nlink!==1)throw Error('Invalid bounded installation file');const chunks:Buffer[]=[];let n=0;for await(const b of f.createReadStream({autoClose:false})){n+=b.length;if(n>max)throw Error('Installation input exceeded capacity');chunks.push(b);}return Buffer.concat(chunks);}finally{await f.close();}
}
async function durable(filename:string,bytes:Buffer,mode=0o600):Promise<void>{
 const tmp=join(dirname(filename),'.install-'+randomUUID()),f=await open(tmp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,mode);let moved=false;
 try{await f.chmod(mode);await f.writeFile(bytes);await f.sync();await f.close();await rename(tmp,filename);moved=true;const parent=await open(dirname(filename),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await parent.sync();}finally{await parent.close();}}
 finally{await f.close().catch(()=>{});if(!moved)await unlink(tmp).catch(()=>{});}
}
async function joinedGroup(group:number):Promise<void>{for(;;){let live=false;for(const id of await readdir('/proc'))if(/^\d+$/u.test(id)){let stat:string;try{stat=await readFile('/proc/'+id+'/stat','utf8');}catch(e){if(['ENOENT','ESRCH'].includes((e as NodeJS.ErrnoException).code??''))continue;throw e;}const fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');if(Number(fields[2])===group&&!['Z','X'].includes(fields[0])){live=true;break;}}if(!live)return;await new Promise(r=>setTimeout(r,10));}}
function fixedChild(command:string,args:readonly string[],signal:AbortSignal,uid?:number,gid?:number,output=false):Promise<Buffer>{return new Promise((resolveResult,reject)=>{
 // stdin is ignored; sudo password input can never reach systemctl. No shell,
 // inherited loader options, PATH lookup, user systemctl or arbitrary verbs.
 if(signal.aborted){reject(Error('Fixed helper cancelled'));return;}
 const child=spawn(command,[...args],{uid,gid,detached:true,stdio:['ignore',output?'pipe':'ignore','ignore'],env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C'}});let error:Error|undefined;const chunks:Buffer[]=[];let bytes=0;
 const kill=()=>{if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')error=Error('Privileged child termination failed');}};
 const cancel=()=>{error??=Error('Fixed helper cancelled');kill();};signal.addEventListener('abort',cancel,{once:true});
 child.stdout?.on('data',(b:Buffer)=>{bytes+=b.length;if(bytes>2*1024*1024){error=Error('Fixed helper output exceeded capacity');kill();}else chunks.push(b);});
 child.once('error',()=>{error=Error('Fixed child failed');});child.once('exit',kill);child.once('close',code=>{void (child.pid?joinedGroup(child.pid):Promise.resolve()).then(()=>{signal.removeEventListener('abort',cancel);error||code!==0?reject(error??Error('Fixed child failed')):resolveResult(Buffer.concat(chunks));},()=>{signal.removeEventListener('abort',cancel);reject(Object.assign(Error('Privileged child cleanup could not be confirmed'),{code:'HELPER_JOIN_FAILED'}));});});if(signal.aborted)cancel();
 });}
async function dataInputs(m:FixedInstallManifest,fixture:FixedInstallFixture|undefined,signal:AbortSignal):Promise<{profileSha:string;bundleSha:string;env:Buffer|null}>{
 if(fixture){let env:Buffer|null=null;try{env=await readBounded(join(m.dataPath,'systemd/moonraker.env'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}return {profileSha:digest(await readBounded(m.profile,1024*1024)),bundleSha:digest(await readBounded(join(m.bundle,'build-info.json'),4*1024*1024)),env};}
 // Read service-user-controlled paths ONLY after dropping to that user's UID.
 // Parent symlinks cannot turn this into a privileged arbitrary-file reader.
 const passwd=(await readBounded('/etc/passwd')).toString('utf8').split('\n').map(s=>s.split(':')).find(s=>s[0]===m.user),uid=Number(passwd?.[2]),gid=Number(passwd?.[3]);if(!Number.isSafeInteger(uid)||uid<=0||!Number.isSafeInteger(gid)||gid<0)throw Error('Unknown non-root service user');
 await assertRootPath('/usr/bin/setpriv',true);
 const code=`const fs=await import('node:fs/promises'),c=await import('node:crypto');if(process.getuid()===0||process.getgroups().some(g=>g!==process.getgid()))throw Error();async function read(p,max){const f=await fs.open(p,131072|2048);try{const s=await f.stat();if(!s.isFile()||s.size>max)throw Error();const chunks=[];let n=0;for(;;){const b=Buffer.alloc(Math.min(65536,max+1-n));const r=await f.read(b);if(!r.bytesRead)break;n+=r.bytesRead;if(n>max)throw Error();chunks.push(b.subarray(0,r.bytesRead));}return Buffer.concat(chunks);}finally{await f.close();}}const hash=b=>c.createHash('sha256').update(b).digest('hex');let env=null;try{env=(await read(process.argv[3],65536)).toString('base64');}catch(e){if(e.code!=='ENOENT')throw e;}console.log(JSON.stringify({profileSha:hash(await read(process.argv[1],1048576)),bundleSha:hash(await read(process.argv[2],4194304)),env}));`;
 const result=JSON.parse((await fixedChild('/usr/bin/setpriv',['--reuid',String(uid),'--regid',String(gid),'--clear-groups','--',m.node,'--input-type=module','-e',code,m.profile,join(m.bundle,'build-info.json'),join(m.dataPath,'systemd/moonraker.env')],signal,undefined,undefined,true)).toString());if(typeof result.env!=='string'&&result.env!==null)throw Error('Invalid fixed data read');return {...result,env:result.env===null?null:Buffer.from(result.env,'base64')};
}
export async function runFixedInstallHelper(manifestPath:string,operation:'probe'|'install'|'status'|'restart',fixture?:FixedInstallFixture,signal:AbortSignal=AbortSignal.timeout(60000),expectedManifestSha256?:string):Promise<FixedInstallReceipt>{
 if(!['probe','install','status','restart'].includes(operation))throw Error('Unsupported fixed installation operation');
 if(!fixture){if(process.platform!=='linux'||process.getuid?.()!==0)throw Error('Administrator helper requires Linux root');await assertRootPath(manifestPath);await assertRootPath(await realpath(process.execPath),true);await assertRootPath('/usr/bin/systemctl',true);}
 if(expectedManifestSha256!==undefined&&!/^[a-f0-9]{64}$/u.test(expectedManifestSha256))throw Error('Invalid expected manifest digest');
 const manifestBytes=await readBounded(manifestPath);if(expectedManifestSha256!==undefined&&digest(manifestBytes)!==expectedManifestSha256)throw Error('Installation manifest identity changed');const m=JSON.parse(manifestBytes.toString('utf8')) as FixedInstallManifest;validateManifest(m);
 if(!fixture){await assertRootPath(m.node,true);if(m.node!==await realpath(process.execPath))throw Error('Helper runtime identity differs from fixed Node executable');}
 const inputs=await dataInputs(m,fixture,signal);if(inputs.profileSha!==m.profileSha256||inputs.bundleSha!==m.bundleManifestSha256)throw Error('Fixed installation input identity changed');
 const candidate=Buffer.from(fixedInstallUnit(m));if(digest(candidate)!==m.candidateSha256)throw Error('Regenerated candidate identity differs');
 const root=fixture?.root??'/',unit=join(root,'etc/systemd/system',m.unit),state=join(root,'var/lib/anyraid-install',m.unit),receiptFile=join(state,'receipt.json');
 const attest=async()=>{const directory=join(root,'var/lib/anyraid-install-attestations');await mkdir(directory,{mode:0o755}).catch(e=>{if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;});if(!fixture)await assertRootPath(directory,false,true);else if(!(await lstat(directory)).isDirectory()||(await lstat(directory)).isSymbolicLink())throw Error('Invalid isolated attestation directory');await chmod(directory,0o755);await durable(join(directory,m.unit+'.json'),Buffer.from(JSON.stringify({schema:1,unit:m.unit,candidateSha256:m.candidateSha256,unitSha256:m.candidateSha256,profileSha256:m.profileSha256,bundleManifestSha256:m.bundleManifestSha256})+'\n'),0o644);};
 if(!fixture){await assertRootPath(unit);await assertRootPath(dirname(unit),false,true);await assertRootPath(join(root,'var/lib'),false,true);}
 let current=await readBounded(unit),receipt:FixedInstallReceipt={schema:1,phase:digest(current)===m.candidateSha256?'ready':'unknown',candidateSha256:m.candidateSha256,unitSha256:digest(current),backup:null,envBackup:null};
 try{if(!fixture)await assertRootPath(receiptFile);const previous=JSON.parse((await readBounded(receiptFile)).toString('utf8')) as FixedInstallReceipt;if(previous.schema!==1||Object.keys(previous).length!==6||Object.keys(previous).some(k=>!['schema','phase','candidateSha256','unitSha256','backup','envBackup'].includes(k))||!['unknown','installed'].includes(previous.phase)||previous.candidateSha256!==m.candidateSha256||previous.unitSha256!==null&&!/^[a-f0-9]{64}$/u.test(previous.unitSha256)||previous.backup!==join(state,'previous.service')||previous.envBackup!==null&&previous.envBackup!==join(state,'previous.env'))throw Error('Fixed receipt identity differs');receipt={schema:1,phase:previous.phase,candidateSha256:m.candidateSha256,unitSha256:digest(current),backup:previous.backup,envBackup:previous.envBackup};if(receipt.phase==='installed'&&receipt.unitSha256!==m.candidateSha256)receipt.phase='unknown';}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 if(operation==='probe'||operation==='status')return receipt;
 const command=fixture?.command??(async(args:readonly string[])=>{await fixedChild('/usr/bin/systemctl',args,signal);});
 if(operation==='restart'){if(receipt.phase!=='installed'||receipt.unitSha256!==m.candidateSha256)throw Error('Confirmed installation required before restart');await command(['--no-block','restart','--',m.unit]);return receipt;}
 // Never replay a prior unknown privileged step, even if the pathname currently
 // matches: successful daemon-reload and durable receipt are separate facts.
 if(receipt.phase==='installed'&&receipt.unitSha256===m.candidateSha256){await attest();return receipt;}
 try{await readBounded(receiptFile);throw Error('Unknown previous privileged installation requires administrator reconciliation');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 const base=dirname(state);await mkdir(base,{mode:0o700}).catch(e=>{if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;});if(!fixture)await assertRootPath(base,false,true);else if(!(await lstat(base)).isDirectory()||(await lstat(base)).isSymbolicLink())throw Error('Invalid isolated state base');await mkdir(state,{mode:0o700}).catch(e=>{if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;});if(!fixture)await assertRootPath(state,false,true);else if(!(await lstat(state)).isDirectory()||(await lstat(state)).isSymbolicLink())throw Error('Invalid isolated state');
 const lockPath=join(state,'owner.lock');let lock;let cleanupUnknown=false;
 try{lock=await open(lockPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw Error('Fixed installation lock requires administrator reconciliation');throw e;}
 try{await lock.writeFile(JSON.stringify({pid:process.pid}));await lock.sync();await fixture?.afterLock?.();
 // Recheck under the cross-process lock; only this owner can create backups.
 try{await readBounded(receiptFile);throw Error('Privileged receipt appeared concurrently');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 signal.throwIfAborted();current=await readBounded(unit);if(digest(current)!==m.previousUnitSha256&&digest(current)!==m.candidateSha256)throw Error('Existing unit differs from administrator-approved identity');const backup=join(state,'previous.service'),envBackup=inputs.env!==null?join(state,'previous.env'):null;
 // Durable unknown precedes backup/replacement/reload side effects. Private
 // bookkeeping directories/lock were created under verified root-only parents.
 receipt={...receipt,phase:'unknown',backup,envBackup};await durable(receiptFile,Buffer.from(JSON.stringify(receipt)+'\n'));await durable(backup,current);
 if(inputs.env!==null){await durable(envBackup!,inputs.env);inputs.env.fill(0);}
 signal.throwIfAborted();if(digest(await readBounded(unit))!==digest(current))throw Error('Existing unit changed during backup');await durable(unit,candidate,0o644);await command(['daemon-reload']);signal.throwIfAborted();current=await readBounded(unit);if(digest(current)!==m.candidateSha256)throw Error('Installed unit identity changed');
 receipt={...receipt,phase:'installed',unitSha256:digest(current)};await durable(receiptFile,Buffer.from(JSON.stringify(receipt)+'\n'));await attest();return receipt;
 }catch(e){cleanupUnknown=(e as NodeJS.ErrnoException).code==='HELPER_JOIN_FAILED';throw e;}finally{await lock.close();if(!cleanupUnknown)await unlink(lockPath);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 if(process.argv.length===4&&process.argv[2]==='--prepare'){try{process.stdout.write(JSON.stringify(await prepareFixedInstallManifest(process.argv[3]),null,2)+'\n');}catch{process.stderr.write('Fixed installation preparation failed\n');process.exitCode=1;}}
 else {
 // No fixture root or arbitrary payload may enter the privileged CLI.
 const args=process.argv.slice(2),stop=new AbortController(),timer=setTimeout(()=>stop.abort(),60000),cancel=()=>stop.abort();let controlBytes=0;process.stdin.on('data',(b:Buffer)=>{controlBytes+=b.length;if(controlBytes>8192)cancel();});process.stdin.on('end',cancel);process.stdin.resume();process.on('SIGTERM',cancel);process.on('SIGINT',cancel);
 try{if(![2,3].includes(args.length)||!['probe','install','status','restart'].includes(args[1])||args.length===3&&!/^[a-f0-9]{64}$/u.test(args[2]))throw Error('Expected fixed manifest, operation and optional manifest digest');const result=await runFixedInstallHelper(args[0],args[1] as 'probe'|'install'|'status'|'restart',undefined,stop.signal,args[2]);process.stdout.write(JSON.stringify(result)+'\n');}catch{process.stderr.write('Fixed installation helper failed; administrator reconciliation may be required\n');process.exitCode=1;}finally{clearTimeout(timer);process.stdin.destroy();process.removeListener('SIGTERM',cancel);process.removeListener('SIGINT',cancel);}
 }
}
