import {BlockList,isIP} from 'node:net';
/** Explicit numeric socket-peer policy. DNS and proxy delegation are separate
 * contracts; unsupported entries fail configuration instead of granting access. */
export class TrustedClients {
 readonly #rules=new BlockList();
 constructor(entries:readonly string[]=[]){
  if(!Array.isArray(entries)||entries.length>1024)throw new TypeError('Invalid trusted_clients list');
  for(const entry of entries){
   if(typeof entry!=='string')throw new TypeError('Invalid trusted_clients entry');
   const parts=entry.trim().split('/'),address=parts[0],family=isIP(address);
   if(!family||address.includes('%')||parts.length>2)throw new TypeError('trusted_clients currently requires numeric IP addresses or CIDR networks');
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
  if(typeof address!=='string'||address.includes('%'))return false;const family=isIP(address);return !!family&&this.#rules.check(address,family===4?'ipv4':'ipv6');
 }
}
