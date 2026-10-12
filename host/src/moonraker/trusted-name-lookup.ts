import {spawn,type ChildProcess} from 'node:child_process';
import {isIP} from 'node:net';
import {fileURLToPath} from 'node:url';
export interface TrustedNameLookup {lookup(address:string,signal:AbortSignal):Promise<string|null>;close():Promise<void>;}
/** At most four owned NSS children, each including startup in its five-second
 * deadline. No shell, inherited NODE_OPTIONS, shared libuv lookup or credentials.
 * A failed lookup never grants trust; caller cancellation still propagates. */
export class NativeTrustedNameLookup implements TrustedNameLookup {
 readonly #children=new Set<ChildProcess>();readonly #shutdown=new AbortController();#close:Promise<void>|undefined;
 lookup(address:string,signal:AbortSignal):Promise<string|null>{
  signal.throwIfAborted();if(this.#shutdown.signal.aborted)return Promise.reject(this.#shutdown.signal.reason);
  if(!isIP(address)||address.includes('%')||this.#children.size>=4)return Promise.resolve(null);
  const lifetime=AbortSignal.any([signal,this.#shutdown.signal]),result=Promise.withResolvers<string|null>();
  const path=fileURLToPath(new URL(import.meta.url.endsWith('.ts')?'./trusted-name-lookup-child.ts':'./trusted-name-lookup-child.js',import.meta.url));
  let child:ChildProcess;try{child=spawn(process.execPath,['--max-old-space-size=32','--max-semi-space-size=4',path,address],{stdio:['ignore','pipe','ignore'],env:{LANG:'C',...process.env.ANYRAID_UNIX_PEER_ADDON?{ANYRAID_UNIX_PEER_ADDON:process.env.ANYRAID_UNIX_PEER_ADDON}:{}}});}catch{return Promise.resolve(null);}
  this.#children.add(child);let bytes=0,output='',failed=false,aborted=false;
  const kill=()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');};
  const abort=()=>{aborted=true;kill();};lifetime.addEventListener('abort',abort,{once:true});if(lifetime.aborted)abort();
  const timer=setTimeout(()=>{failed=true;kill();},5000);
  child.stdout!.on('data',(data:Buffer)=>{bytes+=data.length;if(bytes>8192){failed=true;kill();return;}output+=data.toString('utf8');});
  child.on('error',()=>{failed=true;});
  child.once('close',code=>{clearTimeout(timer);lifetime.removeEventListener('abort',abort);this.#children.delete(child);
   if(aborted||lifetime.aborted){result.reject(lifetime.reason);return;}
   if(failed||code!==0){result.resolve(null);return;}
   try{const name:unknown=JSON.parse(output);result.resolve(typeof name==='string'&&name.length<=4096&&name.isWellFormed()?name:null);}catch{result.resolve(null);}
  });return result.promise;
 }
 get status(){return {active:this.#children.size,closed:this.#shutdown.signal.aborted};}
 close():Promise<void>{
  if(this.#close)return this.#close;this.#shutdown.abort(new DOMException('Trusted name owner closed','AbortError'));
  this.#close=Promise.all([...this.#children].map(child=>new Promise<void>(resolve=>{child.once('close',()=>resolve());if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}))).then(()=>{});return this.#close;
 }
}
