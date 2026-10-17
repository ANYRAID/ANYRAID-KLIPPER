// Git repository engine, based on Moonraker 1cfb0c41 git_deploy.py (GPL-3.0-or-later).
// No HTTP registration, dependency installation or service control lives here.
import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {lstat,realpath,readFile,mkdtemp,rename,mkdir,open,rm,readdir,readlink,symlink} from 'node:fs/promises';
import {dirname,join,resolve,relative,isAbsolute,sep} from 'node:path';
import type {Json} from './rpc.ts';
import {GitVersion} from './update-git-version.ts';

export interface GitRepositoryConfig {
 name:string;path:string;origin:string;primaryBranch:string;channel:'stable'|'beta'|'dev';
 pinnedCommit?:string;reportAnomalies?:boolean;reservedPaths?:readonly string[];
 /** Internal/test-only explicit permission. Public configurations must not enable this. */
 allowFileOrigin?:boolean;timeoutMs?:number;maxOutputBytes?:number;
}
interface RepoIdentity {root:string;git:string;kind:'repo'|'worktree'|'submodule';}
interface Rollback {commit:string;branch:string;version:string;detached:boolean;}
interface Transaction {
 action:'update'|'rollback'|'recover';stage:'prepared'|'applying'|'cloned'|'old-moved'|'installed'|'interrupted';
 before:Rollback;target:string;oldIdentity:RepoIdentity;staging?:string;backup?:string;newIdentity?:RepoIdentity;
}
export interface GitRepositoryStorage {
 schema:1;config:string;identity?:RepoIdentity;rollback?:Rollback;transaction?:Transaction;
}
export interface GitMutationContext {
 signal:AbortSignal;
 /** Rechecks process admission/authentication before every destructive boundary. */
 authorize:()=>void|Promise<void>;
 /** Must atomically and durably replace the previous state, rejecting on failure. */
 persist:(state:GitRepositoryStorage)=>Promise<void>;
}
export class GitCommandError extends Error {
 readonly code:number|null;readonly reason:'exit'|'cancelled'|'timeout'|'capacity'|'spawn';
 constructor(reason:GitCommandError['reason'],code:number|null=null){super('Git command '+reason);this.name='GitCommandError';this.reason=reason;this.code=code;}
}
const cleanText=(value:unknown):value is string=>typeof value==='string'&&value.length<=4096&&value.isWellFormed()&&!/[\0\r\n]/u.test(value);
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{40,64}$/u.test(value);
const branch=(value:string)=>/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value)&&!value.includes('..')&&!value.includes('//')&&!value.endsWith('/')&&!value.endsWith('.lock');
const contains=(parent:string,child:string)=>{const part=relative(parent,child);return part===''||!isAbsolute(part)&&part!=='..'&&!part.startsWith('..'+sep);};
const id=(stat:{dev:bigint;ino:bigint})=>`${stat.dev}:${stat.ino}`;
const same=(a:RepoIdentity,b:RepoIdentity)=>a.root===b.root&&a.git===b.git&&a.kind===b.kind;
const rollbackValid=(v:unknown):v is Rollback=>{if(!v||typeof v!=='object')return false;const r=v as Rollback;return hash(r.commit)&&cleanText(r.branch)&&branch(r.branch)&&cleanText(r.version)&&typeof r.detached==='boolean';};

/** Bounded argv-only process owner; cancellation joins close and kills Git's helper group. */
export async function runGitCommand(path:string,args:readonly string[],signal:AbortSignal,options:{timeoutMs?:number;maxOutputBytes?:number;executable?:string}={}):Promise<string>{
 signal.throwIfAborted();
 const env:NodeJS.ProcessEnv={};
 for(const key of ['PATH','SystemRoot','WINDIR','TEMP','TMP','HOME','USERPROFILE','SSL_CERT_FILE','SSL_CERT_DIR'])if(process.env[key]!==undefined)env[key]=process.env[key];
 Object.assign(env,{LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_ASKPASS:'',SSH_ASKPASS:'',GIT_OPTIONAL_LOCKS:'0',GIT_NO_REPLACE_OBJECTS:'1',GIT_LFS_SKIP_SMUDGE:'1'});
 const defaults=['-c','core.hooksPath='+ (process.platform==='win32'?'NUL':'/dev/null'),'-c','core.fsmonitor=false','-c','core.untrackedCache=false','-c','credential.helper=','-c','credential.interactive=false','-c','gc.auto=0','-c','maintenance.auto=false','-c','protocol.allow=never','-c','protocol.https.allow=always','-c','protocol.file.allow=always','-c','fetch.recurseSubmodules=false','-c','submodule.recurse=false','-c','http.followRedirects=false','--no-pager'];
 return await new Promise<string>((done,fail)=>{
  let reason:GitCommandError['reason']|undefined,bytes=0;const output:Buffer[]=[];
  const child=spawn(options.executable??'git',[...defaults,'-C',path,...args],{env,shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
  const kill=()=>{try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}};
  const stop=(why:GitCommandError['reason'])=>{reason??=why;kill();};
  const abort=()=>stop('cancelled');signal.addEventListener('abort',abort,{once:true});
  if(signal.aborted)abort();
  const timer=setTimeout(()=>stop('timeout'),options.timeoutMs??300000);timer.unref();
  const collect=(data:Buffer,isOutput:boolean)=>{bytes+=data.length;if(bytes>(options.maxOutputBytes??4*1024*1024)){stop('capacity');return;}if(isOutput)output.push(data);};
  child.stdout.on('data',data=>collect(data,true));child.stderr.on('data',data=>collect(data,false));
  child.on('error',()=>{reason??='spawn';});
  child.once('close',code=>{clearTimeout(timer);signal.removeEventListener('abort',abort);if(reason)fail(new GitCommandError(reason,code));else if(code!==0)fail(new GitCommandError('exit',code));else done(Buffer.concat(output).toString('utf8'));});
 });
}

export class GitRepository {
 readonly config:GitRepositoryConfig;#state:GitRepositoryStorage;#identity:RepoIdentity|undefined;#gitDir='';#tail:Promise<unknown>=Promise.resolve();#closed=false;readonly #life=new AbortController();
 #snapshot:Record<string,Json>={};#rawUrl='';#tracking='';#current:Rollback|undefined;#target='?';#selectedVersion:string|undefined;#dirty=false;#untracked=false;#valid=false;#lastRefreshSucceeded=false;
 constructor(config:GitRepositoryConfig){
  if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(config.name)||!isAbsolute(config.path)||resolve(config.path)!==config.path||!branch(config.primaryBranch)||!['stable','beta','dev'].includes(config.channel)||config.pinnedCommit!==undefined&&!/^[a-fA-F0-9]{8,64}$/u.test(config.pinnedCommit))throw Error('Invalid git deployment configuration');
  this.config={...config,reservedPaths:[...config.reservedPaths??[]]};this.#validateUrl(config.origin);
  this.#state={schema:1,config:this.#configKey()};this.#empty();
 }
 #configKey(){return JSON.stringify([this.config.name,this.config.path,this.config.origin,this.config.primaryBranch,this.config.channel,this.config.pinnedCommit??'']);}
 #empty(){this.#valid=false;this.#current=undefined;this.#target='?';this.#snapshot={detected_type:'git_repo',repo_detected:false,is_valid:false,remote_alias:'?',branch:'?',owner:'?',repo_name:'?',remote_url:'?',recovery_url:'?',version:'?',remote_version:'?',rollback_version:this.#state?.rollback?.version??'?',current_hash:'?',remote_hash:'?',is_dirty:false,detached:false,commits_behind:[],commits_behind_count:0,git_messages:[],full_version_string:'?',pristine:false,corrupt:false,warnings:[],anomalies:[],channel:this.config.channel,configured_type:'git_repo',name:this.config.name};}
 get status():Record<string,Json>{return structuredClone({...this.#snapshot,transaction_state:this.#state.transaction?.stage??'idle'});}
 /** Metadata/transport outcome, independently of dirty/diverged/valid state. */
 get lastRefreshSucceeded():boolean{return this.#lastRefreshSucceeded;}
 get storage():GitRepositoryStorage{return structuredClone(this.#state);}
 restore(value:unknown):void{
  if(value===undefined)return;
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid saved git state');const r=value as GitRepositoryStorage;
  if(r.schema!==1||r.config!==this.#configKey())throw Error('Git state configuration changed');
  const identityValid=(v:RepoIdentity|undefined)=>v===undefined||v&&/^\d+:\d+$/u.test(v.root)&&/^\d+:\d+$/u.test(v.git)&&['repo','worktree','submodule'].includes(v.kind);
  if(!identityValid(r.identity)||r.rollback!==undefined&&!rollbackValid(r.rollback))throw Error('Invalid saved git identity or rollback');
  if(r.transaction){const t=r.transaction;if(!['update','rollback','recover'].includes(t.action)||!['prepared','applying','cloned','old-moved','installed','interrupted'].includes(t.stage)||!rollbackValid(t.before)||!hash(t.target)||!t.oldIdentity||!identityValid(t.oldIdentity)||!identityValid(t.newIdentity))throw Error('Invalid saved git transaction');
   for(const path of [t.staging,t.backup])if(path!==undefined&&(!cleanText(path)||dirname(path)!==dirname(this.config.path)||!path.startsWith(join(dirname(this.config.path),'.'+this.config.name+'-'))))throw Error('Invalid saved git recovery path');
  }
  this.#state=structuredClone(r);if(this.#state.transaction)this.#state.transaction.stage='interrupted';
 }
 #queue<T>(fn:()=>Promise<T>):Promise<T>{if(this.#closed)return Promise.reject(Error('Git repository closed'));const task=this.#tail.then(fn);this.#tail=task.then(()=>{},()=>{});return task;}
 async close():Promise<void>{this.#closed=true;this.#life.abort(Error('Git repository closed'));await this.#tail;}
 initialize(signal:AbortSignal):Promise<void>{return this.refresh(signal,false);}
 refresh(signal:AbortSignal,fetch=true):Promise<void>{const combined=AbortSignal.any([signal,this.#life.signal]);return this.#queue(()=>fetch?this.#exclusive(combined,false,()=>this.#refresh(combined,true)):this.#refresh(combined,false));}
 async #exclusive<T>(signal:AbortSignal,_recover:boolean,fn:()=>Promise<T>):Promise<T>{
  signal.throwIfAborted();if(process.platform!=='linux')throw Error('Git deployment mutation requires Linux directory locks');
  await this.#checkReserved(this.config.path);
  if(await realpath(dirname(this.config.path))!==dirname(this.config.path))throw Error('Git parent directory must be physical');
  const lock=join(dirname(this.config.path),'.anyraid-git-'+createHash('sha256').update(this.config.path).digest('hex'));
  await this.#checkReserved(lock);
  await mkdir(lock,{mode:0o700}).catch(e=>{if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;});
  const fd=await open(lock,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{const st=await fd.stat();if(st.uid!==process.getuid!()||(st.mode&0o077)!==0)throw Error('Git control directory must be private and service-owned');
   const native=createRequire(import.meta.url)('../../build/sealed-file.node') as {lockDirectory(fd:number):void};
   try{native.lockDirectory(fd.fd);}catch{throw Error('Git repository is locked by another owner');}signal.throwIfAborted();return await fn();
  }finally{await fd.close();}
 }
 async #identityAt(root=this.config.path):Promise<RepoIdentity>{
  const st=await lstat(root,{bigint:true});if(!st.isDirectory()||st.isSymbolicLink()||await realpath(root)!==root)throw Error('Git path must be a physical directory');
  await this.#checkReserved(root);
  for(let parent=dirname(root);;parent=dirname(parent)){try{await lstat(join(parent,'.git'));throw Error('Git path is nested in another repository');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}if(dirname(parent)===parent)break;}
  let git=join(root,'.git'),kind:RepoIdentity['kind']='repo';const entry=await lstat(git,{bigint:true});
  if(entry.isSymbolicLink())throw Error('Git directory may not be a symbolic link');
  if(entry.isFile()){if(entry.size>4096n)throw Error('Invalid git pointer');const value=await readFile(git,'utf8');if(!/^gitdir: [^\r\n]+\s*$/u.test(value))throw Error('Invalid git pointer');git=resolve(root,value.slice(8).trim());kind=dirname(git).endsWith(sep+'worktrees')?'worktree':'submodule';}
  const gs=await lstat(git,{bigint:true});if(!gs.isDirectory()||gs.isSymbolicLink()||await realpath(git)!==git)throw Error('Invalid git metadata directory');
  if(root===this.config.path)this.#gitDir=git;
  return {root:id(st),git:id(gs),kind};
 }
 async #checkReserved(root:string){for(const reserved of this.config.reservedPaths??[]){let canonical=resolve(reserved);try{canonical=await realpath(canonical);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}if(contains(root,canonical)||contains(canonical,root))throw Error('Git path overlaps reserved process path');}}
 async #assertIdentity(signal:AbortSignal){signal.throwIfAborted();const actual=await this.#identityAt();if(!this.#identity||!same(actual,this.#identity))throw Error('Git deployment identity changed');}
 async #git(args:string[],signal:AbortSignal,guard=true){const combined=AbortSignal.any([signal,this.#life.signal]);if(guard)await this.#assertIdentity(combined);return (await runGitCommand(this.config.path,args,combined,this.config)).trimEnd();}
 async #configSafety(signal:AbortSignal){
  // config is inspected without includes before commands that can invoke configured programs.
  for(const name of ['config','objects/info/alternates','objects/info/http-alternates']){try{const s=await lstat(join(this.#gitDir,name));if(s.isSymbolicLink()||name!=='config')throw Error('External/shared git metadata is unsupported');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
  const values=await this.#git(['config','--no-includes','--local','--null','--list'],signal);
  for(const item of values.split('\0')){const key=item.split('\n',1)[0]!.toLowerCase();if(/^(include\.|includeif\.|filter\.|url\.|protocol\.|http\.|credential\.|core\.(sshcommand|gitproxy|worktree)|remote\..*\.(uploadpack|receivepack|proxy|vcs)|extensions\.)/u.test(key))throw Error('Unsafe or unsupported git configuration');}
 }
 #validateUrl(value:string){
  if(!cleanText(value))throw Error('Invalid git origin');
  if(this.config?.allowFileOrigin&&isAbsolute(value)&&resolve(value)===value)return;
  let url:URL;try{url=new URL(value);}catch{throw Error('Unsupported git origin transport');}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!url.hostname||value.includes('::'))throw Error('Git origins require credential-free HTTPS');
 }
 async #url(remote:string,signal:AbortSignal){if(!branch(remote))throw Error('Invalid tracking remote');const values=(await this.#git(['config','--no-includes','--local','--get-all',`remote.${remote}.url`],signal)).split('\n');if(values.length!==1)throw Error('Git remote must have exactly one URL');this.#validateUrl(values[0]!);return values[0]!;}
 async #resolve(ref:string,signal:AbortSignal):Promise<string>{const value=await this.#git(['rev-parse','--verify','--end-of-options',ref+'^{commit}'],signal);if(!hash(value))throw Error('Invalid git commit');return value;}
 async #ancestor(a:string,b:string,signal:AbortSignal):Promise<boolean>{try{await this.#git(['merge-base','--is-ancestor',a,b],signal);return true;}catch(e){if(e instanceof GitCommandError&&e.reason==='exit'&&e.code===1)return false;throw e;}}
 async #fetch(signal:AbortSignal){
  // URL is used directly; repository-controlled refspecs and remote helper programs are ignored.
  const remote=this.#snapshot.remote_alias as string,branchName=this.#snapshot.branch as string;
  await this.#git(['fetch','--no-recurse-submodules','--no-write-fetch-head','--no-auto-maintenance','--tags','--',this.#rawUrl,`+refs/heads/${branchName}:refs/remotes/${remote}/${branchName}`],signal);
 }
 async #refresh(signal:AbortSignal,fetch:boolean):Promise<void>{
  this.#lastRefreshSucceeded=false;this.#empty();this.#selectedVersion=undefined;const warnings:string[]=[],anomalies:string[]=[];this.#snapshot.warnings=warnings;this.#snapshot.anomalies=this.config.reportAnomalies?anomalies:[];
  try{
   signal.throwIfAborted();const identity=await this.#identityAt();
   if(this.#state.identity&&!same(identity,this.#state.identity))throw Error('Git deployment identity changed');this.#identity=identity;
   await this.#configSafety(signal);this.#snapshot.repo_detected=true;this.#snapshot.repo_type=identity.kind;
   if(identity.kind!=='repo')warnings.push('Shared worktree/submodule is read-only; deployment actions are unavailable.');
   const porcelain=await this.#git(['status','--porcelain=v1','-z','--untracked-files=all','--ignore-submodules=all'],signal);
   const entries=porcelain.split('\0').filter(Boolean);this.#dirty=entries.some(s=>!s.startsWith('??'));this.#untracked=entries.some(s=>s.startsWith('??'));
   let currentBranch='?',detached=false;try{currentBranch=await this.#git(['symbolic-ref','--quiet','--short','HEAD'],signal);}catch(e){if(!(e instanceof GitCommandError&&e.code===1))throw e;detached=true;}
   if(detached){const saved=this.#state.rollback;currentBranch=saved?.branch??this.config.primaryBranch;warnings.push('Detached HEAD detected');}
   if(!branch(currentBranch))throw Error('Invalid git branch');
   let remote='?';try{remote=await this.#git(['config','--no-includes','--local','--get',`branch.${currentBranch}.remote`],signal);}catch(e){if(!(e instanceof GitCommandError&&e.code===1))throw e;}
   if(remote==='?'||remote==='.')throw Error('Failed to detect tracking remote');
   this.#rawUrl=await this.#url(remote,signal);this.#tracking=`refs/remotes/${remote}/${currentBranch}`;
   const origin=await this.#url('origin',signal);if(origin!==this.config.origin)anomalies.push('Configured origin differs from detected origin');
   this.#snapshot.remote_alias=remote;this.#snapshot.branch=currentBranch;this.#snapshot.remote_url=this.#rawUrl;this.#snapshot.recovery_url=origin;
   const parsed=this.#rawUrl.startsWith('https:')?new URL(this.#rawUrl):undefined;const parts=(parsed?.pathname??this.#rawUrl).split('/').filter(Boolean);this.#snapshot.repo_name=(parts.at(-1)??'?').replace(/\.git$/u,'');this.#snapshot.owner=parsed?(parts.at(-2)??'?'):'?';
   if(fetch&&identity.kind==='repo')await this.#fetch(signal);else if(fetch)warnings.push('Remote fetch is unavailable for shared git metadata.');
   const current=await this.#resolve('HEAD',signal),tip=await this.#resolve(this.#tracking,signal);
   let version=await this.#git(['describe','--always','--tags','--long','--dirty','--abbrev=8'],signal);
   this.#current={commit:current,branch:currentBranch,version,detached};
   const tags=await this.#tags(tip,signal);this.#target=await this.#selectTarget(current,tip,tags,signal);
   let upstreamVersion=this.#selectedVersion??(this.#target==='?'?'?':await this.#git(['describe',this.#target,'--always','--tags','--long','--abbrev=8'],signal));
   const diverged=!detached&&!await this.#ancestor(current,tip,signal);
   const count=this.#target==='?'?0:Number(await this.#git(['rev-list','--count',`${current}..${this.#target}`],signal));
   const commits:Json[]=[];
   if(count){const rows=await this.#git(['log',`${current}..${this.#target}`,'--max-count=100','--format=%H%x00%an%x00%ct%x00%s%x00%b%x00'],signal);const fields=rows.split('\0');for(let i=0;i+4<fields.length;i+=5){const sha=fields[i]!.trim();if(!sha)continue;const tag=tags.find(t=>t.commit===sha)?.name??null;if(commits.length<30||tag)commits.push({sha,author:fields[i+1]!,date:fields[i+2]!,subject:fields[i+3]!,message:fields[i+4]!,tag});}}
   if(this.#dirty)warnings.push('Repo is dirty');if(this.#untracked)anomalies.push('Repo has untracked files');if(diverged)anomalies.push('Repo has diverged from remote');if(currentBranch!==this.config.primaryBranch||remote!=='origin')anomalies.push('Repo not on official remote/branch');
   let cur=new GitVersion(version),up=new GitVersion(upstreamVersion);
   if(!cur.isValid){const count=await this.#git(['rev-list','HEAD','--count'],signal);cur=new GitVersion(`${up.inferLastTag()}-${count}-g${current.slice(0,8)}-inferred`);version=cur.fullVersion;}
   if(this.config.channel==='dev'&&!up.isValid){const devCount=cur.inferred?await this.#git(['rev-list',tip,'--count'],signal):String(BigInt(count)+cur.devCount);up=new GitVersion(`${cur.tag}-${devCount}-inferred`);upstreamVersion=up.fullVersion;}
   if(this.config.channel!=='dev'&&!up.isValid){up=cur;upstreamVersion=cur.fullVersion;}
   this.#current.version=version;
   this.#valid=!detached&&!diverged&&!this.#dirty&&this.#target!=='?'&&identity.kind==='repo';
   Object.assign(this.#snapshot,{is_valid:this.#valid,version:cur.shortVersion,remote_version:up.shortVersion,current_hash:current,remote_hash:this.#target,rollback_version:new GitVersion(this.#state.rollback?.version??version).shortVersion,is_dirty:this.#dirty,detached,commits_behind:commits,commits_behind_count:count,full_version_string:version,pristine:!this.#dirty&&!this.#untracked,diverged,shallow:await this.#exists(join(this.#gitDir,'shallow'))});
   this.#state.identity=identity;
   this.#lastRefreshSucceeded=true;
  }catch(e){signal.throwIfAborted();this.#valid=false;this.#snapshot.is_valid=false;warnings.push(e instanceof GitCommandError?'Unable to read Git repository metadata':'Git repository validation failed');this.#snapshot.corrupt=this.#snapshot.repo_detected===true&&e instanceof GitCommandError;}
 }
 async #exists(path:string){try{await lstat(path);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}}
 async #tags(tip:string,signal:AbortSignal){const output=await this.#git(['for-each-ref','--count=100','--sort=-creatordate','--contains=HEAD','--merged='+tip,'--format=%(if)%(*objecttype)%(then)%(*objecttype) %(*objectname)%(else)%(objecttype) %(objectname)%(end) %(refname)','refs/tags'],signal);return output.split('\n').flatMap(line=>{const [type,commit,ref]=line.split(' ');return type==='commit'&&hash(commit)&&ref?[{commit,name:ref.split('/').at(-1)!}]:[];});}
 async #selectTarget(current:string,tip:string,tags:{commit:string;name:string}[],signal:AbortSignal):Promise<string>{
  if(this.config.pinnedCommit){let pin:string;try{pin=await this.#resolve(this.config.pinnedCommit,signal);}catch(e){if(!(e instanceof GitCommandError))throw e;if(this.config.reportAnomalies)(this.#snapshot.anomalies as Json[]).push('Pinned commit does not exist');return current;}return await this.#ancestor(current,pin,signal)?pin:current;}
  if(this.config.channel==='dev')return tip;
  // Version comparison is supplied below using the fixed upstream GitVersion contract.
  return this.#releaseTarget(current,tags,signal);
 }
 async #releaseTarget(current:string,tags:{commit:string;name:string}[],signal:AbortSignal):Promise<string>{
  const candidate=tags.find(t=>{const v=new GitVersion(t.name);return v.isValid&&(this.config.channel==='stable'?v.isFinal:!v.isAlpha);});
  if(!candidate)return current;this.#selectedVersion=candidate.name;
  let cur=new GitVersion(this.#current!.version);const upstream=new GitVersion(candidate.name);
  if(!cur.isValid)cur=new GitVersion(`${upstream.inferLastTag()}-${await this.#git(['rev-list','HEAD','--count'],signal)}-g${current.slice(0,8)}-inferred`);
  return upstream.lessEqual(cur)?current:candidate.commit;
 }
 async #admit(context:GitMutationContext,shared=false,inspectConfig=true){context.signal.throwIfAborted();await context.authorize();context.signal.throwIfAborted();await this.#assertIdentity(context.signal);if(!shared&&this.#identity!.kind!=='repo')throw Error('Shared git checkout cannot be mutated');if(inspectConfig)await this.#configSafety(context.signal);}
 async #save(context:GitMutationContext){context.signal.throwIfAborted();await context.persist(this.storage);context.signal.throwIfAborted();}
 async #write(args:string[],context:GitMutationContext){await this.#admit(context);return this.#git(args,context.signal);}
 async #prepare(action:Transaction['action'],target:string,context:GitMutationContext){if(!this.#current||!this.#identity||!hash(target))throw Error('Repository has no valid recovery state');this.#state.transaction={action,stage:'prepared',before:{...this.#current},target,oldIdentity:{...this.#identity}};await this.#save(context);}
 async #finish(context:GitMutationContext){await this.#refresh(context.signal,false);if(!this.#current||this.#current.commit!==this.#state.transaction!.target||this.#dirty)throw Error('Git mutation verification failed');const next=this.storage;delete next.transaction;await context.persist(next);this.#state=next;}
 async #failed(context:GitMutationContext){if(this.#state.transaction){this.#state.transaction.stage='interrupted';try{await context.persist(this.storage);}catch{}}}
 update(context:GitMutationContext):Promise<boolean>{context={...context,signal:AbortSignal.any([context.signal,this.#life.signal])};return this.#queue(()=>this.#exclusive(context.signal,false,async()=>{
  if(this.#state.transaction)throw Error('Interrupted Git action requires explicit recovery');await this.#refresh(context.signal,false);await this.#admit(context);await this.#refresh(context.signal,true);await this.#admit(context);
  if(!this.#valid||this.#dirty||this.#untracked)throw Error('Update requires a clean valid repository');if(this.#target===this.#current!.commit)return false;
  await this.#prepare('update',this.#target,context);this.#state.rollback={...this.#current!};
  try{this.#state.transaction!.stage='applying';await this.#save(context);await this.#write(['merge','--ff-only','--no-edit','--no-stat',this.#target],context);await this.#finish(context);return true;}catch(e){await this.#failed(context);throw e;}
 }));}
 rollback(context:GitMutationContext):Promise<boolean>{context={...context,signal:AbortSignal.any([context.signal,this.#life.signal])};return this.#queue(()=>this.#exclusive(context.signal,false,async()=>{
  if(this.#state.transaction)throw Error('Interrupted Git action requires explicit recovery');await this.#refresh(context.signal,false);await this.#admit(context);if(this.#dirty||this.#untracked)throw Error('Rollback requires a clean repository');
  const rollback=this.#state.rollback;if(!rollback)throw Error('No rollback state stored');await this.#resolve(rollback.commit,context.signal);if(this.#current?.commit===rollback.commit&&this.#current.branch===rollback.branch)return false;
  await this.#prepare('rollback',rollback.commit,context);
  try{this.#state.transaction!.stage='applying';await this.#save(context);if(rollback.detached)await this.#write(['checkout','--detach',rollback.commit],context);else await this.#write(['checkout',rollback.branch],context);await this.#write(['reset','--hard',rollback.commit],context);await this.#finish(context);return true;}catch(e){await this.#failed(context);throw e;}
 }));}
 recover(context:GitMutationContext,hard=false):Promise<void>{context={...context,signal:AbortSignal.any([context.signal,this.#life.signal])};return this.#queue(()=>this.#exclusive(context.signal,true,async()=>{
  if(this.#state.transaction?.staging){await this.#resumeClone(context);return;}
  if(hard){
   // A trusted prior directory identity is sufficient for clone recovery. Never
   // execute Git against damaged/hostile old metadata in this path.
   if(!this.#state.identity)throw Error('Hard recovery requires a previously trusted directory identity');
   const actual=await this.#identityAt();if(!same(actual,this.#state.identity))throw Error('Git deployment identity changed');this.#identity=actual;await this.#admit(context,false,false);
   for(const entry of ['worktrees','modules']){const path=join(this.#gitDir,entry);try{const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink()||(await readdir(path)).length)throw Error('Hard recovery cannot replace a repository with linked worktrees or submodules');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
   this.#current??=this.#state.rollback??{commit:'0'.repeat(40),branch:this.config.primaryBranch,version:'?',detached:false};
   const backup=await mkdtemp(join(dirname(this.config.path),'.'+this.config.name+'-backup-'));await this.#prepare('recover',this.#current.commit,context);this.#state.transaction!.backup=backup;
   try{await this.#clone(context,true);}catch(e){await this.#failed(context);throw e;}return;
  }
  await this.#refresh(context.signal,false);await this.#admit(context);
  if(!this.#current)throw Error('Unreadable HEAD requires explicit hard recovery with a trusted directory identity');
  await this.#fetch(context.signal);
  const primaryRemote=await this.#git(['config','--no-includes','--local','--get',`branch.${this.config.primaryBranch}.remote`],context.signal);const primary=await this.#resolve(`refs/remotes/${primaryRemote}/${this.config.primaryBranch}`,context.signal);
  let target=primary;for(const ref of [this.config.pinnedCommit,this.#current.commit]){if(!ref)continue;try{const sha=await this.#resolve(ref,context.signal);if(await this.#ancestor(sha,primary,context.signal)){target=sha;break;}}catch(e){if(!(e instanceof GitCommandError))throw e;}}
  // Recovery is explicitly destructive, so first preserve the entire old tree, including untracked files.
  const backup=await mkdtemp(join(dirname(this.config.path),'.'+this.config.name+'-backup-'));await this.#admit(context);if(!hard)await this.#copyBackup(this.config.path,join(backup,'repository'),context.signal);
  await this.#prepare('recover',target,context);this.#state.transaction!.backup=backup;
  try{if(hard)await this.#clone(context);else{this.#state.transaction!.stage='applying';await this.#save(context);await this.#write(['reset','--hard','HEAD'],context);await this.#write(['checkout',this.config.primaryBranch],context);await this.#write(['reset','--hard',target],context);await this.#finish(context);delete this.#state.rollback;await this.#save(context);}}catch(e){await this.#failed(context);throw e;}
 }));}
 async #copyBackup(source:string,dest:string,signal:AbortSignal){
  const deadline=Date.now()+300000;let bytes=0,entries=0;const pending=[[source,dest]],identities:{path:string;signature:string}[]=[];
  const signature=(st:{dev:bigint;ino:bigint;size:bigint;mtimeNs:bigint;ctimeNs:bigint})=>`${id(st)}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
  while(pending.length){signal.throwIfAborted();if(Date.now()>deadline||++entries>100000)throw Error('Recovery backup capacity exceeded');const [src,dst]=pending.pop()!;const st=await lstat(src!);
   if(st.isSymbolicLink()){await symlink(await readlink(src!),dst!);continue;}if(st.isDirectory()){await mkdir(dst!,{mode:st.mode});for(const name of await readdir(src!))pending.push([join(src!,name),join(dst!,name)]);continue;}if(!st.isFile())throw Error('Unsupported recovery backup entry');
   const input=await open(src!,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const before=await input.stat({bigint:true});if(!before.isFile()||Number(before.dev)!==st.dev||Number(before.ino)!==st.ino)throw Error('Recovery backup source changed');
    const output=await open(dst!,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,st.mode);try{const buffer=Buffer.alloc(1024*1024);for(;;){signal.throwIfAborted();if(Date.now()>deadline)throw Error('Recovery backup deadline exceeded');const r=await input.read(buffer,0,buffer.length,null);if(!r.bytesRead)break;bytes+=r.bytesRead;if(bytes>1024*1024*1024)throw Error('Recovery backup capacity exceeded');let at=0;while(at<r.bytesRead){const written=await output.write(buffer,at,r.bytesRead-at,null);if(!written.bytesWritten)throw Error('Recovery backup write stalled');at+=written.bytesWritten;}}await output.sync();}finally{await output.close();}
    if(signature(before)!==signature(await input.stat({bigint:true})))throw Error('Recovery backup source changed');identities.push({path:src!,signature:signature(before)});
   }finally{await input.close();}
  }
  for(const entry of identities){signal.throwIfAborted();if(signature(await lstat(entry.path,{bigint:true}))!==entry.signature)throw Error('Recovery backup source changed');}
 }
 async #syncDirectories(paths:string[]){for(const path of new Set(paths)){const fd=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await fd.sync();}finally{await fd.close();}}}
 async #clone(context:GitMutationContext,unknownTarget=false){
  const t=this.#state.transaction!;t.staging=await mkdtemp(join(dirname(this.config.path),'.'+this.config.name+'-clone-'));await this.#save(context);await this.#admit(context,false,false);
  await runGitCommand(dirname(this.config.path),['clone','--no-checkout','--no-local','--origin','origin','--branch',this.config.primaryBranch,'--',this.config.origin,join(t.staging,'repository')],context.signal,this.config);
  await runGitCommand(join(t.staging,'repository'),['checkout',this.config.primaryBranch],context.signal,this.config);
  if(unknownTarget){
   const clone=join(t.staging,'repository'),tip=(await runGitCommand(clone,['rev-parse','HEAD'],context.signal,this.config)).trim();if(!hash(tip))throw Error('Invalid recovery clone target');t.target=tip;
   for(const ref of [this.config.pinnedCommit,t.before.commit]){if(!ref)continue;try{const sha=(await runGitCommand(clone,['rev-parse','--verify','--end-of-options',ref+'^{commit}'],context.signal,this.config)).trim();if(!hash(sha))throw Error('Invalid recovery commit');await runGitCommand(clone,['merge-base','--is-ancestor',sha,tip],context.signal,this.config);t.target=sha;break;}catch(e){if(!(e instanceof GitCommandError&&e.reason==='exit'))throw e;}}
  }
  await runGitCommand(join(t.staging,'repository'),['reset','--hard',t.target],context.signal,this.config);
  const staged=new GitRepository({...this.config,path:join(t.staging,'repository')});try{await staged.initialize(context.signal);if(!staged.status.repo_detected||staged.status.corrupt||staged.status.current_hash!==t.target)throw Error('Recovery clone validation failed');}finally{await staged.close();}
  t.newIdentity=await this.#identityAt(join(t.staging,'repository'));t.stage='cloned';await this.#save(context);await this.#installClone(context);
 }
 async #installClone(context:GitMutationContext){
  const t=this.#state.transaction!;const staging=join(t.staging!,'repository');const moved=join(t.backup!,'original');
  await this.#admit(context,false,false);if(!same(await this.#identityAt(staging),t.newIdentity!))throw Error('Clone identity changed');
  // Persist both identities and deterministic rename locations before either rename.
  t.stage='old-moved';await this.#save(context);await this.#admit(context,false,false);await rename(this.config.path,moved);
  // Once the first rename commits, complete the second rename despite cancellation.
  // A failed install restores the old path before returning to the caller.
  try{await rename(staging,this.config.path);await this.#syncDirectories([dirname(this.config.path),t.backup!,t.staging!]);}catch(e){if(!await this.#exists(this.config.path)){await rename(moved,this.config.path);await this.#syncDirectories([dirname(this.config.path),t.backup!]);}throw e;}
  this.#identity=t.newIdentity;this.#state.identity=t.newIdentity;t.stage='installed';await context.persist(this.storage);context.signal.throwIfAborted();await this.#finish(context);delete this.#state.rollback;await this.#save(context);
 }
 async #resumeClone(context:GitMutationContext){
  const t=this.#state.transaction!,staging=join(t.staging!,'repository'),moved=join(t.backup!,'original');context.signal.throwIfAborted();await context.authorize();
  if(!t.newIdentity)throw Error('Interrupted clone was not verified; retain backup and inspect manually');
  if(await this.#exists(this.config.path)){
   const current=await this.#identityAt();if(same(current,t.newIdentity)){this.#identity=current;this.#state.identity=current;await this.#finish(context);return;}
   if(!same(current,t.oldIdentity))throw Error('Recovery path identity changed');this.#identity=current;
   if(!same(await this.#identityAt(staging),t.newIdentity))throw Error('Recovery clone identity changed');await this.#installClone(context);return;
  }
  if(!same(await this.#identityAt(moved),t.oldIdentity)||!same(await this.#identityAt(staging),t.newIdentity))throw Error('Interrupted clone identities changed');
  context.signal.throwIfAborted();await context.authorize();await rename(staging,this.config.path);await this.#syncDirectories([dirname(this.config.path),t.staging!,t.backup!]);this.#identity=t.newIdentity;this.#state.identity=t.newIdentity;await this.#finish(context);
 }
}
