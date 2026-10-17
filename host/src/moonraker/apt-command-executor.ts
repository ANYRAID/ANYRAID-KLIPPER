// GPL-3.0-or-later. Linux argv-only APT execution; no shell or ambient env.
import {spawn} from 'node:child_process';
import {readdir,readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {StringDecoder} from 'node:string_decoder';

export type AptErrorCode='invalid'|'unsupported'|'unavailable'|'busy'|'closed'|'authorization'|'aborted'|'timeout'|'output'|'failed'|'drain'|'interrupted'|'journal';
export class AptPackageError extends Error {
 readonly code:AptErrorCode;readonly dispatched:boolean;readonly exitCode:number|null;
 constructor(code:AptErrorCode,message:string,dispatched=false,exitCode:number|null=null){super(message);this.name='AptPackageError';this.code=code;this.dispatched=dispatched;this.exitCode=exitCode;}
}
export interface AptOperationContext {signal:AbortSignal;authorize:()=>void|Promise<void>;onOutput?:(stream:'stdout'|'stderr',text:string)=>void;}
export interface AptCommandRequest extends AptOperationContext {
 command:string;args:readonly string[];env:Readonly<Record<string,string>>;timeoutMs:number;maxOutputBytes:number;effect:'query'|'cache'|'install'|'upgrade';
}
export interface AptCommandResult {stdout:string;stderr:string;exitCode:0;}
export interface AptCommandExecutor {run(request:AptCommandRequest):Promise<AptCommandResult>;close?():Promise<void>;}
export const aptCommandPath=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=4096&&isAbsolute(value)&&value.isWellFormed()&&!/[\0\r\n]/u.test(value);
const codeOf=(error:unknown)=>(error as NodeJS.ErrnoException|undefined)?.code;
async function groupExists(group:number):Promise<boolean>{try{process.kill(-group,0);return true;}catch(error){if(codeOf(error)==='ESRCH')return false;throw error;}}
async function liveGroup(group:number):Promise<boolean>{
 if(!await groupExists(group))return false;
 for(const entry of await readdir('/proc'))if(/^[0-9]+$/u.test(entry)){
  let value:string;try{value=await readFile('/proc/'+entry+'/stat','utf8');}catch(error){if(['ENOENT','ESRCH'].includes(codeOf(error)??''))continue;throw error;}
  const fields=value.slice(value.lastIndexOf(')')+2).split(' ');if(Number(fields[2])===group&&!['Z','X'].includes(fields[0]))return true;
 }
 return false;
}
async function drainGroup(group:number):Promise<void>{
 const deadline=Date.now()+5000;
 while(await liveGroup(group)){
  try{process.kill(-group,'SIGKILL');}catch(error){if(codeOf(error)!=='ESRCH')throw error;}
  if(Date.now()>=deadline)throw new AptPackageError('drain','APT process group did not drain',true);
  await new Promise(resolve=>setTimeout(resolve,10));
 }
}
function validate(request:AptCommandRequest):void{
 if(!aptCommandPath(request.command)||!Array.isArray(request.args)||request.args.length>1024||request.args.some(arg=>typeof arg!=='string'||arg.length>65536||!arg.isWellFormed()||/[\0\r\n]/u.test(arg)))throw new AptPackageError('invalid','Invalid trusted APT command');
 if(!Number.isSafeInteger(request.timeoutMs)||request.timeoutMs<1||request.timeoutMs>3600000||!Number.isSafeInteger(request.maxOutputBytes)||request.maxOutputBytes<1||request.maxOutputBytes>16*1024*1024)throw new AptPackageError('invalid','Invalid APT execution limits');
 if(!request.env||Object.keys(request.env).length>32||Object.entries(request.env).some(([key,value])=>!/^[A-Z_][A-Z0-9_]*$/u.test(key)||typeof value!=='string'||value.length>4096||/[\0\r\n]/u.test(value)))throw new AptPackageError('invalid','Invalid trusted APT environment');
}

/** Owns one detached process group; close aborts and joins it. A failed drain
 * retains the group for a later close attempt and blocks all new execution. */
export class ProcessAptCommandExecutor implements AptCommandExecutor {
 #life=new AbortController();#active:Promise<AptCommandResult>|undefined;#groups=new Set<number>();#closed=false;
 run(request:AptCommandRequest):Promise<AptCommandResult>{
  try{validate(request);if(process.platform!=='linux')throw new AptPackageError('unavailable','APT process execution requires Linux');if(this.#closed)throw new AptPackageError('closed','APT executor is closed');if(this.#active||this.#groups.size)throw new AptPackageError('busy','APT executor is busy or not drained');}catch(error){return Promise.reject(error);}
  const task=this.#execute({...request,signal:AbortSignal.any([request.signal,this.#life.signal])});this.#active=task;void task.finally(()=>{if(this.#active===task)this.#active=undefined;}).catch(()=>{});return task;
 }
 async #execute(request:AptCommandRequest):Promise<AptCommandResult>{
  if(request.signal.aborted)throw new AptPackageError('aborted','APT execution was cancelled');try{await request.authorize();}catch{throw new AptPackageError('authorization','APT execution authorization denied');}if(request.signal.aborted)throw new AptPackageError('aborted','APT execution was cancelled');
  let dispatched=false;
  const result=await new Promise<AptCommandResult>((resolve,reject)=>{
   let failure:AptPackageError|undefined,bytes=0,exitCode:number|null=null,closed=false,timer:ReturnType<typeof setTimeout>|undefined,terminationTimer:ReturnType<typeof setTimeout>|undefined;
   const stdout:Buffer[]=[],stderr:Buffer[]=[];
   const decoders={stdout:new StringDecoder('utf8'),stderr:new StringDecoder('utf8')};
   const child=spawn(request.command,[...request.args],{env:{...request.env},detached:true,stdio:['ignore','pipe','pipe'],shell:false});
   dispatched=child.pid!==undefined;if(child.pid)this.#groups.add(child.pid);
   const kill=()=>{if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch(error){if(codeOf(error)!=='ESRCH')failure??=new AptPackageError('drain','APT process group could not be stopped',dispatched);}};
   const boundTermination=()=>{terminationTimer??=setTimeout(()=>reject(new AptPackageError('drain','APT process streams did not drain',dispatched)),5000);};
   const stop=(code:AptErrorCode,message:string)=>{failure??=new AptPackageError(code,message,dispatched);kill();boundTermination();};
   const abort=()=>stop('aborted','APT execution was cancelled');
   child.once('spawn',()=>{dispatched=true;if(child.pid)this.#groups.add(child.pid);if(request.signal.aborted)abort();});
   child.once('error',()=>{failure??=new AptPackageError('unavailable','APT command could not be executed',dispatched);});
   const collect=(buffer:Buffer[],stream:'stdout'|'stderr',chunk:Buffer)=>{
    bytes+=chunk.length;if(bytes>request.maxOutputBytes){stop('output','APT output exceeded capacity');return;}
    buffer.push(chunk);if(request.onOutput)try{const text=decoders[stream].write(chunk);if(text)request.onOutput(stream,text);}catch{stop('failed','APT output observer failed');}
   };
   child.stdout.on('data',(chunk:Buffer)=>collect(stdout,'stdout',chunk));child.stderr.on('data',(chunk:Buffer)=>collect(stderr,'stderr',chunk));
   request.signal.addEventListener('abort',abort,{once:true});if(request.signal.aborted)abort();timer=setTimeout(()=>stop('timeout','APT execution timed out'),request.timeoutMs);
   child.once('exit',code=>{exitCode=code;kill();boundTermination();});
   child.once('close',()=>{if(closed)return;closed=true;clearTimeout(timer);clearTimeout(terminationTimer);request.signal.removeEventListener('abort',abort);
    void (async()=>{
     if(child.pid){try{await drainGroup(child.pid);this.#groups.delete(child.pid);}catch{failure=new AptPackageError('drain','APT process group did not drain',dispatched);}}
     if(failure)throw failure;if(exitCode!==0)throw new AptPackageError('failed','APT command failed',dispatched,exitCode);
     try{return {stdout:new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(stdout)),stderr:new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(stderr)),exitCode:0 as const};}catch{throw new AptPackageError('output','APT output was not valid UTF-8',dispatched);}
    })().then(resolve,reject);
   });
  });
  if(request.signal.aborted)throw new AptPackageError('aborted','APT execution was cancelled',dispatched);
  try{await request.authorize();}catch{throw new AptPackageError('authorization','APT execution authorization changed',dispatched);}
  if(request.signal.aborted)throw new AptPackageError('aborted','APT execution was cancelled',dispatched);return result;
 }
 async close():Promise<void>{this.#closed=true;this.#life.abort();await Promise.allSettled(this.#active?[this.#active]:[]);for(const group of this.#groups){await drainGroup(group);this.#groups.delete(group);}}
}
