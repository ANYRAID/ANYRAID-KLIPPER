import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import type {FileHandle} from 'node:fs/promises';
/** A separate signal domain proves no writable descriptor exists at admission,
 * then fences reopening for write until the import owner retires this lease. */
export class FileWriteLease {
 readonly #child:ChildProcessWithoutNullStreams;readonly #abort=new AbortController();readonly #exit=Promise.withResolvers<void>();readonly #ready=Promise.withResolvers<boolean>();
 #check:ReturnType<typeof Promise.withResolvers<void>>|undefined;#started=false;#closing=false;#buffer='';#error='';#timer:ReturnType<typeof setTimeout>;#dispose:()=>void;
 private constructor(source:FileHandle,signal:AbortSignal){
  this.#child=spawn(process.env.ANYRAID_FILE_WRITE_LEASE_HELPER??fileURLToPath(new URL('../../build/file-write-lease',import.meta.url)),[],{stdio:['pipe','pipe','pipe',source.fd]}) as ChildProcessWithoutNullStreams;
  const cancel=()=>this.#fail(signal.reason);signal.addEventListener('abort',cancel,{once:true});this.#dispose=()=>signal.removeEventListener('abort',cancel);
  this.#timer=setTimeout(()=>this.#fail(new Error(`Write lease lifetime exceeded (pid=${this.#child.pid}, started=${this.#started}, checking=${!!this.#check}): ${this.#error}`)),30000);
  this.#child.stdin.on('error',error=>{if(!this.#closing)this.#fail(error);});
  this.#child.stderr.on('data',bytes=>{const text=String(bytes),remaining=1024-this.#error.length;this.#error+=text.slice(0,remaining);if(text.length>remaining)this.#fail(new Error(`Write lease helper exceeded diagnostic limit (pid=${this.#child.pid}): ${this.#error}`));});
  this.#child.stdout.on('data',bytes=>{
   this.#buffer+=String(bytes);if(this.#buffer.length>256){this.#fail(new Error('Invalid write lease protocol'));return;}
   for(let at;(at=this.#buffer.indexOf('\n'))>=0;){const line=this.#buffer.slice(0,at);this.#buffer=this.#buffer.slice(at+1);
    if(line==='busy'&&!this.#started){this.#started=true;this.#ready.resolve(false);continue;}
    if(line==='ready'&&!this.#started){this.#started=true;this.#ready.resolve(true);continue;}
    if(line==='held'&&this.#check){this.#check.resolve();this.#check=undefined;continue;}
    this.#fail(new Error(line==='broken'?'Disk archive reopened for writing':'Invalid write lease response'));
   }
  });
  this.#child.on('error',error=>this.#fail(error));
  this.#child.on('close',(code,signal)=>{clearTimeout(this.#timer);this.#dispose();if(!this.#closing)this.#fail(new Error(`Write lease helper exited (${code??signal}): ${this.#error}`));this.#exit.resolve();});
  if(signal.aborted)cancel();
 }
 static async acquire(source:FileHandle,signal:AbortSignal):Promise<FileWriteLease|undefined>{
  signal.throwIfAborted();if(!source||!Number.isSafeInteger(source.fd)||source.fd<0)throw new TypeError('Open source descriptor required');
  const lease=new FileWriteLease(source,signal);try{const ready=await lease.#ready.promise;if(!ready){await lease.close();return;}await lease.check();return lease;}catch(error){await lease.close();throw error;}
 }
 get signal(){return this.#abort.signal;}
 #fail(error:unknown){if(this.#abort.signal.aborted)return;this.#abort.abort(error);this.#ready.reject(error);this.#check?.reject(error);this.#check=undefined;this.#closing=true;this.#child.kill('SIGKILL');}
 async check():Promise<void>{
  this.#abort.signal.throwIfAborted();if(this.#closing)throw new Error('Write lease closed');if(this.#check)throw new Error('Concurrent write lease checks');
  const check=this.#check=Promise.withResolvers<void>();this.#child.stdin.write('C');await check.promise;this.#abort.signal.throwIfAborted();
 }
 async close():Promise<void>{if(!this.#closing){this.#closing=true;this.#child.stdin.end('R');}await this.#exit.promise;}
}
