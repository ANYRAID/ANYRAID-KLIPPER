import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {open,readdir,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isAbsolute,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

export interface CompilerExecution {
 schema:1;binary:string;typescript:string;nativePackage:string;nativeVersion:string;
 platform:string;arch:string;sha256:string;bytes:number;dev:number;ino:number;mode:number;mtimeMs:number;
 scope?:string;resolverPid?:number;compilerPid?:number;resolverGroupStopped?:boolean;compilerGroupStopped?:boolean;
}
export interface CompilerResult {status:number|null;signal:NodeJS.Signals|null;error?:NodeJS.ErrnoException;stdout:string;stderr:string;execution?:CompilerExecution;phase:'resolve'|'compile';groupStopped?:boolean;cleanupComplete:boolean;}
export interface CompilerOptions {timeoutMs:number;maxBuffer:number;signal?:AbortSignal;cwd?:string;/** Trusted build worker only; its parent owns and drains the complete POSIX group. */supervisedGroup?:true;}
function failure(code:string,message:string):NodeJS.ErrnoException{return Object.assign(new Error(message),{code});}
async function groupStopped(group:number):Promise<void>{
 // SIGKILL can precede observable exit. Join live members of only our group;
 // already-dead adopted zombies have no executable work or inherited pipes.
 for(;;){
  try{process.kill(-group,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return;throw error;}
  let live=false;
  for(const id of await readdir('/proc'))if(/^\d+$/u.test(id)){
   let stat:string;try{stat=await readFile('/proc/'+id+'/stat','utf8');}catch(error){if(['ENOENT','ESRCH'].includes((error as NodeJS.ErrnoException).code??''))continue;throw error;}
   const fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');if(Number(fields[2])===group&&!['Z','X'].includes(fields[0])){live=true;break;}
  }
  if(!live)return;await new Promise(resolve=>setTimeout(resolve,10));
 }
}
/** Own only newly detached children. Exit alone does not join inherited pipes. */
function owned(command:string,args:readonly string[],cwd:string,signal:AbortSignal,maxBuffer:number,supervisedGroup=false):Promise<CompilerResult&{pid?:number}>{
 return new Promise(resolveResult=>{
  let error:NodeJS.ErrnoException|undefined,status:number|null=null,exitSignal:NodeJS.Signals|null=null;
  const stdout:Buffer[]=[],stderr:Buffer[]=[];let outBytes=0,errBytes=0;
  const child=spawn(command,[...args],{cwd,detached:!supervisedGroup,stdio:['ignore','pipe','pipe']});
  const killGroup=()=>{
   if(child.pid&&child.pid!==process.pid)try{if(supervisedGroup)child.kill('SIGKILL');else process.kill(-child.pid,'SIGKILL');}catch(cause){if((cause as NodeJS.ErrnoException).code!=='ESRCH')error=failure('KILL_FAILED','Unable to terminate owned compiler group');}
  };
  const terminate=()=>{
   const code=(signal.reason as NodeJS.ErrnoException|undefined)?.code;
   error??=failure(typeof code==='string'?code:'ABORT_ERR',signal.reason instanceof Error?signal.reason.message:'TypeScript compilation cancelled');
   // detached=true creates this child's own POSIX group; never use our group.
   killGroup();
  };
  const collect=(chunks:Buffer[],chunk:Buffer,output:boolean)=>{
   if(output)outBytes+=chunk.length;else errBytes+=chunk.length;
   if((output?outBytes:errBytes)>maxBuffer){error??=failure('ENOBUFS','TypeScript compiler output exceeds capacity');terminate();return;}
   chunks.push(chunk);
  };
  child.stdout.on('data',(chunk:Buffer)=>collect(stdout,chunk,true));child.stderr.on('data',(chunk:Buffer)=>collect(stderr,chunk,false));
  child.once('error',cause=>{error??=cause;});
  signal.addEventListener('abort',terminate,{once:true});if(signal.aborted)terminate();
  child.once('exit',(code,cause)=>{status=code;exitSignal=cause;killGroup();});
  child.once('close',(code,cause)=>{
   const finish=(complete:boolean)=>{
   signal.removeEventListener('abort',terminate);status=code;exitSignal=cause;
   resolveResult({status,signal:exitSignal,...error?{error}:{},stdout:Buffer.concat(stdout).toString('utf8'),stderr:Buffer.concat(stderr).toString('utf8'),pid:child.pid,phase:'resolve',groupStopped:supervisedGroup?undefined:complete,cleanupComplete:supervisedGroup?false:complete});
   };
   void (child.pid&&!supervisedGroup?groupStopped(child.pid):Promise.resolve()).then(()=>finish(true),()=>{error=failure('COMPILER_JOIN_FAILED','Compiler child closed but owned group termination could not be confirmed');finish(false);});
  });
 });
}
async function verifyBinary(execution:CompilerExecution,signal:AbortSignal):Promise<void>{
 signal.throwIfAborted();
 const file=await open(execution.binary,constants.O_RDONLY|constants.O_NONBLOCK|constants.O_NOFOLLOW);
 try{
  const info=await file.stat();if(!info.isFile()||!(info.mode&0o111)||info.size!==execution.bytes||info.size>64*1024**2||info.dev!==execution.dev||info.ino!==execution.ino||info.mode!==execution.mode||info.mtimeMs!==execution.mtimeMs)throw failure('COMPILER_CHANGED','Resolved compiler identity changed');
  const hash=createHash('sha256');let size=0;
  for await(const chunk of file.createReadStream({autoClose:false,signal})){size+=chunk.length;if(size>64*1024**2)throw failure('COMPILER_CHANGED','Compiler exceeds capacity');hash.update(chunk);}
  if(size!==execution.bytes||hash.digest('hex')!==execution.sha256)throw failure('COMPILER_CHANGED','Resolved compiler bytes changed');signal.throwIfAborted();
 }finally{await file.close();}
}
/** One deadline covers official resolution, byte verification and direct spawn.
 * Input hashes describe selected pre-launch bytes, not TOCTOU-free execution. */
export async function runTypeScript(host:string,args:readonly string[],options:CompilerOptions):Promise<CompilerResult>{
 if(process.platform!=='linux'||!['x64','arm64'].includes(process.arch))return {status:null,signal:null,error:failure('ENOTSUP','Owned TypeScript compilation requires Linux x64 or arm64'),stdout:'',stderr:'',phase:'resolve',cleanupComplete:true};
 if(!isAbsolute(host)||!Number.isFinite(options.timeoutMs)||options.timeoutMs<=0||!Number.isSafeInteger(options.maxBuffer)||options.maxBuffer<=0)throw new TypeError('Invalid owned compiler options');
 const lifetime=new AbortController(),signal=options.signal?AbortSignal.any([options.signal,lifetime.signal]):lifetime.signal;
 const timer=setTimeout(()=>lifetime.abort(failure('ETIMEDOUT','TypeScript compiler deadline exceeded')),options.timeoutMs);
 let execution:CompilerExecution|undefined,phase:'resolve'|'compile'='resolve';
 try{
  signal.throwIfAborted();await readdir('/proc');const resolver=await owned(process.execPath,[fileURLToPath(new URL('./typescript-resolver.mjs',import.meta.url)),host],options.cwd??host,signal,Math.min(options.maxBuffer,65536),options.supervisedGroup);
  if(resolver.error||resolver.status!==0)return resolver;
  const value=JSON.parse(resolver.stdout) as CompilerExecution;
  if(value?.schema!==1||typeof value.binary!=='string'||!isAbsolute(value.binary)||value.platform!==process.platform||value.arch!==process.arch||typeof value.typescript!=='string'||!/^7\./u.test(value.typescript)||value.nativeVersion!==value.typescript||value.nativePackage!=='@typescript/typescript-'+process.platform+'-'+process.arch||typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/u.test(value.sha256)||!['bytes','dev','ino','mode','mtimeMs'].every(key=>typeof value[key as keyof CompilerExecution]==='number'&&Number.isFinite(value[key as keyof CompilerExecution] as number)))throw failure('INVALID_RESOLUTION','Invalid official compiler resolution receipt');
  execution={...value,resolverPid:resolver.pid,resolverGroupStopped:options.supervisedGroup?undefined:resolver.groupStopped,scope:'Official locked platform executable selected and bytes rechecked immediately before direct spawn; no PATH lookup or execve launcher. Pre-launch identity does not attest loaded memory or concurrent replacement.'};
  await verifyBinary(execution,signal);phase='compile';
  const result=await owned(execution.binary,args,options.cwd??host,signal,options.maxBuffer,options.supervisedGroup);execution.compilerPid=result.pid;execution.compilerGroupStopped=options.supervisedGroup?undefined:result.groupStopped;execution.scope+=options.supervisedGroup?' Complete inherited process group termination is owned by the trusted build parent.':'';return {...result,phase,execution};
 }catch(cause){return {status:null,signal:null,error:cause instanceof Error?cause:failure('COMPILER_FAILED','TypeScript compilation failed'),stdout:'',stderr:'',phase,cleanupComplete:true,...execution?{execution}:{}};}
 finally{clearTimeout(timer);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const controller=new AbortController();let cancelled:NodeJS.Signals|undefined;
 const interrupt=(signal:NodeJS.Signals)=>{cancelled??=signal;controller.abort(failure('ABORT_ERR','TypeScript compilation cancelled'));};
 const term=()=>interrupt('SIGTERM'),int=()=>interrupt('SIGINT');process.on('SIGTERM',term);process.on('SIGINT',int);
 try{
  const result=await runTypeScript(fileURLToPath(new URL('..',import.meta.url)),process.argv.slice(2),{timeoutMs:120000,maxBuffer:4*1024**2,signal:controller.signal,cwd:process.cwd()});
  process.stdout.write(result.stdout);process.stderr.write(result.stderr);
  if(result.error)process.stderr.write(result.error.message+'\n');
  process.exitCode=cancelled==='SIGTERM'?143:cancelled==='SIGINT'?130:result.error||result.status===null?1:result.status;
 }catch(error){process.stderr.write((error instanceof Error?error.message:'TypeScript compilation failed')+'\n');process.exitCode=1;}
 finally{process.removeListener('SIGTERM',term);process.removeListener('SIGINT',int);}
}
