import {randomBytes} from 'node:crypto';
import {isIP} from 'node:net';
import {ApiError} from './rpc.ts';
/** Socket peer only. Forwarded headers require a separate trusted-proxy policy. */
export function authorizationAddress(value:unknown):string{
 if(typeof value!=='string'||!isIP(value))throw new ApiError(401,'Client address unavailable');
 if(isIP(value)!==6)return value;const at=value.indexOf('%'),ip=at<0?value:value.slice(0,at),zone=at<0?'':value.slice(at);return new URL('http://['+ip+']/').hostname.slice(1,-1)+zone;
}
interface Attempt {failures:number;pending:number;tail:Promise<unknown>;}
/** Failure counts last until a successful login or process restart, as upstream.
 * Per-address serialization prevents concurrent requests bypassing the limit. */
export class LoginAttempts {
 readonly #maximum:number|undefined;readonly #addresses=new Map<string,Attempt>();#pending=0;#closed=false;
 constructor(maximum?:number){if(maximum!==undefined&&(!Number.isSafeInteger(maximum)||maximum<1))throw new ApiError(400,'Invalid maximum login attempts');this.#maximum=maximum;}
 get enabled(){return this.#maximum!==undefined;}
 get status(){return {addresses:this.#addresses.size,pending:this.#pending};}
 run<T>(address:string,signal:AbortSignal,login:()=>Promise<T>):Promise<T>{
  if(this.#closed)throw new ApiError(503,'Login policy closed');signal.throwIfAborted();
  if(this.#maximum===undefined)return login();
  let entry=this.#addresses.get(address);
  if(this.#pending>=32||!entry&&this.#addresses.size>=4096)throw new ApiError(429,'Login policy capacity exceeded');
  if(!entry){entry={failures:0,pending:0,tail:Promise.resolve()};this.#addresses.set(address,entry);}
  const state=entry;state.pending++;this.#pending++;
  const run=state.tail.then(async()=>{
   if(this.#closed)throw new ApiError(503,'Login policy closed');signal.throwIfAborted();
   if(state.failures>=this.#maximum!)throw new ApiError(401,'Unauthorized, Maximum Login Attempts Reached');
   try{const result=await login();state.failures=0;return result;}catch(error){if(!signal.aborted)state.failures++;throw error;}
  });
  state.tail=run.catch(()=>{});return run.finally(()=>{state.pending--;this.#pending--;if(!state.pending&&!state.failures)this.#addresses.delete(address);});
 }
 close(){this.#closed=true;this.#addresses.clear();}
}
interface OneShot<T>{address:string;identity:T;expires:number;}
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(bytes:Uint8Array){let value=0,bits=0,result='';for(const byte of bytes){value=(value<<8)|byte;bits+=8;while(bits>=5){bits-=5;result+=alphabet[(value>>>bits)&31];}}return result;}
/** Five-second monotonic lifetime; consumption removes before address checks. */
export class OneShotTokens<T> {
 readonly #tokens=new Map<string,OneShot<T>>();readonly #now:()=>number;#closed=false;
 constructor(now:()=>number=()=>performance.now()){this.#now=now;}
 #time(){const now=this.#now();if(!Number.isFinite(now)||now<0)throw new ApiError(503,'Invalid token clock');return now;}
 #prune(now:number){for(const [token,entry] of this.#tokens){if(entry.expires>now)break;this.#tokens.delete(token);}}
 get count(){this.#prune(this.#time());return this.#tokens.size;}
 issue(address:string,identity:T):string{
  if(this.#closed)throw new ApiError(503,'Token policy closed');const now=this.#time();this.#prune(now);if(this.#tokens.size>=1024)throw new ApiError(429,'One-shot token capacity exceeded');
  let token:string;do{token=base32(randomBytes(20));}while(this.#tokens.has(token));this.#tokens.set(token,{address,identity,expires:now+5000});return token;
 }
 consume(token:string,address:string):T|undefined{
  if(this.#closed)throw new ApiError(503,'Token policy closed');const entry=this.#tokens.get(token);this.#tokens.delete(token);const now=this.#time();this.#prune(now);
  return entry&&entry.expires>now&&entry.address===address?entry.identity:undefined;
 }
 close(){this.#closed=true;this.#tokens.clear();}
}
