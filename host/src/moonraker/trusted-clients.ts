import {BlockList,isIP} from 'node:net';
import {NativeTrustedNameLookup,type TrustedNameLookup} from './trusted-name-lookup.ts';
export interface TrustedClientOptions {lookup?:TrustedNameLookup;monotonicNow?:()=>number;}
/** Socket peer policy from pinned authorization.py. Host names use libc NSS
 * with an 84000-second cache. Proxy delegation remains a separate contract. */
export class TrustedClients {
 readonly #rules=new BlockList();
 readonly #domains=new Set<string>();readonly #cache=new Map<string,{name:string;expires:number}>();readonly #pending=new Map<string,Promise<boolean>>();
 readonly #shutdown=new AbortController();readonly #now:()=>number;#lookup:TrustedNameLookup|undefined;
 constructor(entries:readonly string[]=[],options:TrustedClientOptions={}){
  this.#lookup=options.lookup;this.#now=options.monotonicNow??(()=>performance.now());
  if(!Array.isArray(entries)||entries.length>1024)throw new TypeError('Invalid trusted_clients list');
  for(const entry of entries){
   if(typeof entry!=='string')throw new TypeError('Invalid trusted_clients entry');
   const parts=entry.trim().split('/'),address=parts[0],family=isIP(address);
   if(!family&&parts.length===1&&address.length>=3&&address.length<=253&&/[a-z]{2}$/.test(address)&&address.split('.').every(label=>/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(label))){this.#domains.add(address);continue;}
   if(!family||address.includes('%')||parts.length>2)throw new TypeError('Invalid trusted_clients address, network or domain');
   const type=family===4?'ipv4':'ipv6';
   if(parts.length===1){this.#rules.addAddress(address,type);continue;}
   const bits=family===4?32:128,prefix=Number(parts[1]);
   if(!/^\d+$/.test(parts[1])||!Number.isSafeInteger(prefix)||prefix<0||prefix>bits)throw new TypeError('Invalid trusted_clients prefix');
   let value:bigint;
   if(family===4)value=address.split('.').reduce((v,part)=>(v<<8n)|BigInt(part),0n);
   else{const canonical=new URL('http://['+address+']/').hostname.slice(1,-1),halves=canonical.split('::'),left=halves[0]?halves[0].split(':'):[],right=halves[1]?halves[1].split(':'):[];
    const words=halves.length===1?left:[...left,...Array(8-left.length-right.length).fill('0'),...right];value=words.reduce((v,part)=>(v<<16n)|BigInt('0x'+part),0n);
   }
   if(value&((1n<<BigInt(bits-prefix))-1n))throw new TypeError('trusted_clients network contains host bits');
   this.#rules.addSubnet(address,prefix,type);
  }
 }
 matches(address:unknown):boolean{
  if(this.#shutdown.signal.aborted||typeof address!=='string'||address.includes('%'))return false;const family=isIP(address);if(!family)return false;
  if(this.#rules.check(address,family===4?'ipv4':'ipv6'))return true;
  const entry=this.#cache.get(address);if(!entry)return false;const now=this.#now();if(!Number.isFinite(now)||now<0||entry.expires<=now){this.#cache.delete(address);return false;}return this.#domains.has(entry.name);
 }
 get hasDomains(){return this.#domains.size>0;}
 async resolve(address:unknown,signal:AbortSignal):Promise<boolean>{
  signal.throwIfAborted();this.#shutdown.signal.throwIfAborted();if(this.matches(address))return true;
  if(!this.hasDomains||typeof address!=='string'||!isIP(address)||address.includes('%'))return false;
  const cached=this.#cache.get(address);if(cached)return false;
  let pending=this.#pending.get(address);
  if(!pending){
   if(this.#pending.size>=16)return false;
   const now=this.#now();if(!Number.isFinite(now)||now<0)return false;
   for(const [key,value]of this.#cache)if(value.expires<=now)this.#cache.delete(key);
   if(this.#cache.size>=4096)return false;
   this.#lookup??=new NativeTrustedNameLookup();
   const work=this.#lookup.lookup(address,this.#shutdown.signal).then(name=>{
    this.#shutdown.signal.throwIfAborted();const time=this.#now();if(typeof name!=='string'||!name.isWellFormed()||name.length>4096||!Number.isFinite(time)||time<0)return false;
    if(this.#cache.size>=4096)return false;
    const canonical=name.toLowerCase();this.#cache.set(address,{name:canonical,expires:time+84000000});return this.#domains.has(canonical);
   },()=>{this.#shutdown.signal.throwIfAborted();return false;}).finally(()=>this.#pending.delete(address));
   pending=work;this.#pending.set(address,work);void work.catch(()=>{});
  }
  signal.throwIfAborted();
  let abort=()=>{};const cancelled=new Promise<never>((_resolve,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});});
  try{const result=await Promise.race([pending,cancelled]);signal.throwIfAborted();this.#shutdown.signal.throwIfAborted();return result;}finally{signal.removeEventListener('abort',abort);}
 }
 async close():Promise<void>{this.#shutdown.abort(new DOMException('Trusted policy closed','AbortError'));this.#cache.clear();await this.#lookup?.close();await Promise.allSettled(this.#pending.values());this.#pending.clear();}
}
