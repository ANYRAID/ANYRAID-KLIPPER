// CORS pattern and trusted-IP semantics from pinned Moonraker authorization.py.
// Original Copyright (C) 2020 Eric Callahan; GPL-3.0-or-later.
import {RE2} from 're2-wasm';
import {TrustedClients} from './trusted-clients.ts';

/** Browser read/upgrade admission only; never grants API or print authority.
 * RE2 bounds regex matching work; unsupported Python-only regex constructs
 * reject configuration instead of silently changing their meaning. */
export class CorsPolicy {
 readonly #patterns:RE2[]=[];
 readonly #exact=new Set<string>();
 readonly #trusted:TrustedClients;
 readonly #enabled:boolean;
 constructor(domains:readonly string[],trusted:readonly string[]=[],warn:(message:string)=>void=()=>{}){
  if(!Array.isArray(domains)||domains.length>128)throw new TypeError('Invalid cors_domains capacity');
  this.#trusted=new TrustedClients(trusted);
  let accepted=0;
  for(const domain of domains){
   if(typeof domain!=='string'||!domain||domain.length>1024||/[\x00-\x20\x7f]/.test(domain))throw new TypeError('Invalid cors_domains pattern');
   if(/^.+\.[^:]*\*/.test(domain)){warn("[authorization]: Unsafe domain '"+domain+"' in option 'cors_domains'. Wildcards are not permitted in the top level domain.");continue;}
   if(domain.endsWith('/')){warn("[authorization]: Invalid domain '"+domain+"' in option 'cors_domains'. Domains cannot contain a trailing slash.");continue;}
   // A literal origin needs no regex engine crossing on the request hot path.
   if(!/[\*\[\]()+?{}|^$\\]/.test(domain))this.#exact.add(domain);
   else{
    const pattern=domain.replaceAll('.','\\.').replaceAll('*','.*');
    try{this.#patterns.push(new RE2(pattern,'u'));}catch{throw new TypeError('Unsupported or invalid cors_domains regular expression');}
   }
   accepted++;
  }
  this.#enabled=accepted>0;
  Object.freeze(this);
 }
 matches(origin:unknown):boolean{
  if(!this.#enabled||typeof origin!=='string'||origin.length>1024)return false;
  let url:URL;
  try{url=new URL(origin);if(!['http:','https:'].includes(url.protocol)||url.origin!==origin)return false;}catch{return false;}
  if(this.#exact.has(origin))return true;
  for(const regex of this.#patterns){const result=regex.exec(origin);if(result?.index===0&&result[0]===origin)return true;}
  // Upstream only tries its trusted-IP fallback after a nonempty pattern list.
  // Preserve its bracketed IPv6 exclusion; numeric IPv6 exact origins remain
  // available through the existing explicit network origins setting.
  const match=/^https?:\/\/([^/:]+)/.exec(origin);
  return !!match&&this.#trusted.matches(match[1]);
 }
}
