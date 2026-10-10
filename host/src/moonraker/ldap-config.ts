// LDAP configuration ownership from pinned Moonraker ldap.py; GPL-3.0-or-later.
import type {ConfigurationReader} from './config-reader.ts';
import {ConfigurationError} from './config-source.ts';
import type {LdapOptions} from './ldap-authorization.ts';
export interface LdapConfigurationContext {
 /** Full template owner remains explicit. Resolved values never enter snapshots. */
 render?:(source:string,signal:AbortSignal)=>string|Promise<string>;
 signal?:AbortSignal;ca?:string;
}
const supported=new Set(['ldap_host','ldap_port','ldap_secure','base_dn','group_dn','bind_dn','bind_password','user_filter','membership_attribute','check_dn_case','is_active_directory']);
const strip=(value:string)=>value.replace(/^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g,'');
async function rendered(source:string|null,context:LdapConfigurationContext,signal:AbortSignal):Promise<string|undefined>{
 if(source===null)return undefined;signal.throwIfAborted();
 if(typeof source!=='string'||!source.isWellFormed()||Buffer.byteLength(source)>65536)throw new ConfigurationError('Invalid LDAP template source');
 if(!context.render&&/[{}]/u.test(source))throw new ConfigurationError('LDAP template owner is required');
 let abort=()=>{};
 const stop=new Promise<never>((_resolve,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});});
 try{
  const value=await Promise.race([Promise.resolve().then(()=>{signal.throwIfAborted();return context.render?context.render(source,signal):source;}),stop]);
  signal.throwIfAborted();if(typeof value!=='string'||!value.isWellFormed()||Buffer.byteLength(value)>65535||value.includes('\0'))throw Error();return strip(value);
 }catch{signal.throwIfAborted();throw new ConfigurationError('Unable to render LDAP configuration');}
 finally{signal.removeEventListener('abort',abort);}
}
/** Resolve all credentials before constructing/starting a directory owner.
 * Literal configurations work directly; templated ones require their owner. */
export async function readLdapOptions(reader:ConfigurationReader,context:LdapConfigurationContext={}):Promise<LdapOptions>{
 if(!reader.hasSection('ldap'))throw new ConfigurationError('LDAP section is required');
 for(const name of Object.keys(reader.source.original.ldap))if(!supported.has(name))throw new ConfigurationError(`Unsupported [ldap] option '${name}'`);
 reader.redact('ldap','bind_password');const section=reader.section('ldap');
 const host=section.get('ldap_host'),port=section.getInt('ldap_port',{defaultValue:null,minval:1,maxval:65535}),secure=section.getBoolean('ldap_secure',{defaultValue:false});
 const membershipAttribute=section.getChoice('membership_attribute',['memberOf','isMemberOf'],{defaultValue:'memberOf'}) as 'memberOf'|'isMemberOf';
 const checkDnCase=section.getBoolean('check_dn_case',{defaultValue:true}),activeDirectory=section.getBoolean('is_active_directory',{defaultValue:false});
 const base=section.get('base_dn'),group=section.get('group_dn',{defaultValue:null}),bind=section.get('bind_dn',{defaultValue:null}),password=section.get('bind_password',{defaultValue:null}),filter=section.get('user_filter',{defaultValue:null});
 if(bind!==null&&password===null)throw new ConfigurationError('[ldap]: bind_password is required with bind_dn');
 const signal=AbortSignal.any([context.signal??new AbortController().signal,AbortSignal.timeout(10000)]);
 try{
  const baseDn=await rendered(base,context,signal),groupDn=await rendered(group,context,signal),bindDn=await rendered(bind,context,signal),bindPassword=bind===null?undefined:await rendered(password,context,signal),userFilter=await rendered(filter,context,signal);
  if(groupDn!==undefined&&!groupDn)throw new ConfigurationError('[ldap]: group_dn must not be empty');
  if(userFilter!==undefined&&!userFilter.includes('USERNAME'))throw new ConfigurationError('[ldap]: user_filter requires USERNAME');
  return {host,...port===null?{}:{port},secure,baseDn:baseDn!,...groupDn===undefined?{}:{groupDn},...bindDn===undefined?{}:{bindDn},...bindPassword===undefined?{}:{bindPassword},...userFilter===undefined?{}:{userFilter},membershipAttribute,checkDnCase,activeDirectory,...context.ca===undefined?{}:{ca:context.ca}};
 }catch{if(context.signal?.aborted)throw context.signal.reason;throw new ConfigurationError('Invalid LDAP configuration or template operation');}
}
