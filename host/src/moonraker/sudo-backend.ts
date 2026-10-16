import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {open,lstat,readFile,readdir,realpath} from 'node:fs/promises';
import {dirname,isAbsolute,resolve} from 'node:path';
import {ApiError} from './rpc.ts';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

export type SudoOperation='probe'|'install'|'status'|'restart';
export interface SudoInstallReceipt {schema:1;phase:'ready'|'installed'|'unknown';candidateSha256:string;unitSha256:string|null;backup:string|null;envBackup:string|null;}
export interface SudoDeploymentDeclaration {schema:1;manifestSha256:string;unit:string;user:string;node:string;bundle:string;profile:string;dataPath:string;profileSha256:string;bundleManifestSha256:string;candidateSha256:string;previousUnitSha256:string;}
export interface SudoBackend {
 /** Internal read-only view bound to exactly the same privileged manifest. */
 deployment?(signal:AbortSignal):Promise<SudoDeploymentDeclaration>;
 execute(operation:SudoOperation,password:Buffer|undefined,signal:AbortSignal):Promise<SudoInstallReceipt>;
 close():Promise<void>;
}
export interface TrustedSudoOptions {mode:'trusted-sudo';sudo:string;node:string;helper:string;manifest:string;timeoutMs?:number;}
const closed=()=>new ApiError(503,'Trusted sudo operation unavailable');
async function trustedPath(filename:string,executable=false):Promise<void>{
 if(typeof filename!=='string'||!isAbsolute(filename)||resolve(filename)!==filename||/[\x00-\x1f\x7f]/u.test(filename))throw closed();
 let current=filename,first=true;for(;;){const s=await lstat(current);if(s.isSymbolicLink()||s.uid!==0||(s.mode&0o022)!==0||first&&(!s.isFile()||executable&&(s.mode&0o111)===0)||!first&&!s.isDirectory())throw closed();if(current==='/')return;current=dirname(current);first=false;}
}
async function noNewPrivileges():Promise<void>{
 const f=await open('/proc/self/status',constants.O_RDONLY|constants.O_NONBLOCK);try{const b=Buffer.alloc(65537);const {bytesRead}=await f.read(b);if(bytesRead>65536||!/^NoNewPrivs:\s+0\s*$/m.test(b.subarray(0,bytesRead).toString()))throw new ApiError(503,'Direct trusted sudo is incompatible with NoNewPrivileges');}finally{await f.close();}
}
async function boundedRead(path:string,max:number):Promise<Buffer>{const file=await open(path,constants.O_RDONLY|constants.O_NONBLOCK|constants.O_NOFOLLOW);try{const s=await file.stat();if(!s.isFile()||s.size>max)throw closed();const chunks:Buffer[]=[];let n=0;for(;;){const b=Buffer.alloc(Math.min(65536,max+1-n)),r=await file.read(b);if(!r.bytesRead)break;n+=r.bytesRead;if(n>max)throw closed();chunks.push(b.subarray(0,r.bytesRead));}return Buffer.concat(chunks);}finally{await file.close();}}
async function publicStatus(manifestPath:string,expectedManifestSha256:string):Promise<SudoInstallReceipt>{
 await trustedPath(manifestPath);const bytes=await boundedRead(manifestPath,65536);if(createHash('sha256').update(bytes).digest('hex')!==expectedManifestSha256)throw closed();const manifest=JSON.parse(bytes.toString());if(!/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,239}\.service$/u.test(manifest.unit)||!/^[a-f0-9]{64}$/u.test(manifest.candidateSha256))throw closed();
 const attestation='/var/lib/anyraid-install-attestations/'+manifest.unit+'.json',unit='/etc/systemd/system/'+manifest.unit;await trustedPath(attestation);await trustedPath(unit);
 const proof=JSON.parse((await boundedRead(attestation,65536)).toString());if(proof.schema!==1||Object.keys(proof).length!==6||proof.unit!==manifest.unit||proof.candidateSha256!==manifest.candidateSha256||proof.unitSha256!==manifest.candidateSha256||proof.profileSha256!==manifest.profileSha256||proof.bundleManifestSha256!==manifest.bundleManifestSha256||createHash('sha256').update(await boundedRead(unit,65536)).digest('hex')!==manifest.candidateSha256)throw closed();
 // Profile/bundle data are read as the ordinary service user here. The root
 // helper never imports them, and these checks do not require cached sudo auth.
 if(createHash('sha256').update(await boundedRead(manifest.profile,1024*1024)).digest('hex')!==proof.profileSha256||createHash('sha256').update(await boundedRead(join(manifest.bundle,'build-info.json'),4*1024*1024)).digest('hex')!==proof.bundleManifestSha256)throw closed();
 return {schema:1,phase:'installed',candidateSha256:proof.candidateSha256,unitSha256:proof.unitSha256,backup:null,envBackup:null};
}
async function joinGroup(group:number):Promise<void>{
 for(;;){try{process.kill(-group,0);}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')return;throw e;}
  let live=false;for(const name of await readdir('/proc'))if(/^\d+$/u.test(name)){let s:string;try{s=await readFile('/proc/'+name+'/stat','utf8');}catch(e){if(['ENOENT','ESRCH'].includes((e as NodeJS.ErrnoException).code??''))continue;throw e;}const fields=s.slice(s.lastIndexOf(')')+2).split(' ');if(Number(fields[2])===group&&!['Z','X'].includes(fields[0])){live=true;break;}}
  if(!live)return;await new Promise(r=>setTimeout(r,10));
 }
}
/** Request cooperative root-helper cancellation by closing stdin. A service
 * user cannot assume it can SIGKILL root children or sudo's separate sessions.
 * The helper has its own deadline/child join; real PAM/relay behavior is a deployment gate. */
export function runOwnedSudo(command:string,args:readonly string[],password:Buffer|undefined,signal:AbortSignal,timeoutMs=60000):Promise<SudoInstallReceipt>{
 return new Promise((resolveResult,reject)=>{
  if(signal.aborted){reject(closed());return;}let failure:Error|undefined;const chunks:Buffer[]=[];let bytes=0;
  const child=spawn(command,[...args],{detached:true,stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C',HOME:'/',LC_ALL:'C'}});
  const kill=()=>{if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')failure=closed();}};
  const cancel=()=>{failure??=closed();child.stdin.end();};const timer=setTimeout(cancel,timeoutMs);signal.addEventListener('abort',cancel,{once:true});
  child.stdin.on('error',()=>{failure??=closed();});child.stdout.on('data',(b:Buffer)=>{bytes+=b.length;if(bytes>65536)cancel();else chunks.push(b);});
  // Do not retain arbitrary sudo/helper stderr: it may contain authentication data.
  let errors=0;child.stderr.on('data',(b:Buffer)=>{errors+=b.length;if(errors>65536)cancel();});child.once('error',()=>{failure??=closed();});
  child.once('exit',()=>kill());child.once('close',code=>{void (child.pid?joinGroup(child.pid):Promise.resolve()).then(()=>{
   clearTimeout(timer);signal.removeEventListener('abort',cancel);if(failure||code!==0){reject(failure??closed());return;}
   try{const r=JSON.parse(Buffer.concat(chunks).toString('utf8')) as SudoInstallReceipt;if(r.schema!==1||!['ready','installed','unknown'].includes(r.phase)||!/^[a-f0-9]{64}$/u.test(r.candidateSha256)||r.unitSha256!==null&&!/^[a-f0-9]{64}$/u.test(r.unitSha256)||[r.backup,r.envBackup].some(p=>p!==null&&(typeof p!=='string'||!isAbsolute(p))))throw Error();resolveResult(r);}catch{reject(closed());}
  },()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);reject(new ApiError(503,'Trusted sudo child group cleanup could not be confirmed',{cleanup_complete:false}));});});
  if(password){const input=Buffer.concat([password,Buffer.from('\n')]);child.stdin.write(input,()=>input.fill(0));}if(signal.aborted)cancel();
 });
}
export async function createTrustedSudoBackend(options:TrustedSudoOptions):Promise<SudoBackend>{
 if(process.platform!=='linux'||!['x64','arm64'].includes(process.arch)||!options||options.mode!=='trusted-sudo'||Object.keys(options).some(k=>!['mode','sudo','node','helper','manifest','timeoutMs'].includes(k))||options.timeoutMs!==undefined&&(!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<1||options.timeoutMs>60000))throw closed();
 // Check all privileged bootstrap code BEFORE launch. Administrators install
 // this standalone helper outside the replaceable, service-writable bundle.
 const validate=async()=>{await noNewPrivileges();for(const p of [options.sudo,options.node,options.helper,options.manifest])await trustedPath(p,p===options.sudo||p===options.node);if(await realpath(options.node)!==options.node)throw closed();};await validate();
 const boundDigest=createHash('sha256').update(await boundedRead(options.manifest,65536)).digest('hex');
 const deployment=async(signal:AbortSignal):Promise<SudoDeploymentDeclaration>=>{await validate();signal.throwIfAborted();const bytes=await boundedRead(options.manifest,65536),manifestSha256=createHash('sha256').update(bytes).digest('hex');if(manifestSha256!==boundDigest)throw closed();const m=JSON.parse(bytes.toString());if(!m||m.schema!==1||Object.keys(m).length!==11||Object.keys(m).some(k=>!['schema','unit','user','node','bundle','profile','dataPath','profileSha256','bundleManifestSha256','candidateSha256','previousUnitSha256'].includes(k))||!/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,239}\.service$/u.test(m.unit)||!/^[a-z_][a-z0-9_-]{0,30}$/u.test(m.user)||m.user==='root'||[m.profileSha256,m.bundleManifestSha256,m.candidateSha256,m.previousUnitSha256].some(v=>typeof v!=='string'||!/^[a-f0-9]{64}$/u.test(v))||[m.node,m.bundle,m.profile,m.dataPath].some(v=>typeof v!=='string'||!isAbsolute(v)||resolve(v)!==v||/[\x00-\x1f\x7f]/u.test(v)))throw closed();signal.throwIfAborted();return Object.freeze({...m,manifestSha256});};
 const stop=new AbortController(),pending=new Set<Promise<unknown>>();let closing:Promise<void>|undefined,cleanupFault:unknown;
 return {deployment(signal){if(stop.signal.aborted)return Promise.reject(closed());const task=deployment(AbortSignal.any([signal,stop.signal]));pending.add(task);return task.finally(()=>pending.delete(task));},execute(operation,password,signal){if(stop.signal.aborted)return Promise.reject(closed());const owned=AbortSignal.any([signal,stop.signal]),task=(async()=>{await deployment(owned);owned.throwIfAborted();if(operation==='status')return publicStatus(options.manifest,boundDigest);return runOwnedSudo(options.sudo,[password?'-S':'-n','-p','','--',options.node,'--no-experimental-strip-types',options.helper,options.manifest,operation,boundDigest],password,owned,options.timeoutMs);})().catch(e=>{if(e instanceof ApiError&&e.data&&typeof e.data==='object'&&!Array.isArray(e.data)&&e.data.cleanup_complete===false)cleanupFault=e;throw e;});pending.add(task);return task.finally(()=>pending.delete(task));},close(){stop.abort(closed());return closing??=Promise.allSettled([...pending]).then(results=>{const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(cleanupFault)errors.push(cleanupFault);if(errors.length)throw new AggregateError(errors,'Trusted sudo shutdown failed');});}};
}
