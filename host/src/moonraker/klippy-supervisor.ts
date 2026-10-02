import {setTimeout as delay} from 'node:timers/promises';
function disconnected(connection:AbortSignal,owner:AbortSignal):Promise<void>{
 if(connection.aborted||owner.aborted)return Promise.resolve();
 return new Promise(resolve=>{const done=()=>{connection.removeEventListener('abort',done);owner.removeEventListener('abort',done);resolve();};connection.addEventListener('abort',done,{once:true});owner.addEventListener('abort',done,{once:true});});
}
/** One connection attempt at a time. Pinned Moonraker waits INIT_TIME=.25s
 * before every attempt, including the first; this owner never retries RPCs. */
export class KlippySupervisor {
 #connect:()=>Promise<AbortSignal>;#disconnect:()=>Promise<void>;#interval:number;
 #owner=new AbortController();#running:Promise<void>|undefined;#stopping:Promise<void>|undefined;
 #phase:'new'|'waiting'|'connecting'|'connected'|'stopping'|'stopped'='new';#attempts=0;#connections=0;#failures=0;#lastError:string|undefined;
 constructor(connect:()=>Promise<AbortSignal>,disconnect:()=>Promise<void>,retryDelayMs=250){
  if(typeof connect!=='function'||typeof disconnect!=='function'||!Number.isSafeInteger(retryDelayMs)||retryDelayMs<1||retryDelayMs>60000)throw new Error('Invalid Klippy supervisor options');
  this.#connect=connect;this.#disconnect=disconnect;this.#interval=retryDelayMs;
 }
 get status(){return {phase:this.#phase,attempts:this.#attempts,connections:this.#connections,failures:this.#failures,retryDelayMs:this.#interval,lastError:this.#lastError};}
 start():void{if(this.#running||this.#owner.signal.aborted)throw new Error('Klippy supervisor already started or stopped');this.#running=this.#run();}
 async #run():Promise<void>{
  try{while(!this.#owner.signal.aborted){
   this.#phase='waiting';try{await delay(this.#interval,undefined,{signal:this.#owner.signal});}catch{break;}
   if(this.#owner.signal.aborted)break;
   this.#phase='connecting';this.#attempts++;
   try{const connection=await this.#connect();if(this.#owner.signal.aborted)break;if(connection.aborted)throw new Error('Klippy generation disconnected during initialization');this.#connections++;this.#lastError=undefined;this.#phase='connected';await disconnected(connection,this.#owner.signal);}
   catch(error){if(this.#owner.signal.aborted)break;this.#failures++;this.#lastError=error instanceof Error?error.message:String(error);}
  }}finally{if(!this.#owner.signal.aborted)this.#phase='stopped';}
 }
 /** The adapter must interrupt an in-flight connect and drain the generation.
  * Ignored cancellation remains owned; a failed drain can be retried. */
 stop():Promise<void>{
  if(this.#stopping)return this.#stopping;if(this.#phase==='stopped')return Promise.resolve();
  this.#phase='stopping';this.#owner.abort();
  this.#stopping=Promise.all([Promise.resolve().then(()=>this.#disconnect()),this.#running]).then(()=>{this.#phase='stopped';}).finally(()=>{this.#stopping=undefined;});return this.#stopping;
 }
}
