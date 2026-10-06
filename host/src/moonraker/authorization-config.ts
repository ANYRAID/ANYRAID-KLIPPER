import {TrustedClients} from './trusted-clients.ts';
import {CorsPolicy} from './cors-policy.ts';
import type {AuthorizationOptions} from './api-key-authorization.ts';
import type {ConfigurationReader} from './config-reader.ts';
import {ConfigurationError} from './config-source.ts';
const supported=new Set(['login_timeout','force_logins','default_source','enable_api_key','max_login_attempts','trusted_clients','cors_domains']);
/** Consume only implemented policy. Never silently ignore an access-control rule. */
export function readAuthorizationOptions(reader:ConfigurationReader,issuer:string):AuthorizationOptions&{cors?:CorsPolicy}{
 let origin:URL;try{origin=new URL(issuer);}catch{throw new ConfigurationError('Invalid authorization issuer');}
 if(!['http:','https:'].includes(origin.protocol)||origin.origin!==issuer)throw new ConfigurationError('Authorization issuer must be an HTTP(S) origin');
 for(const name of Object.keys(reader.source.original.authorization??{}))if(!supported.has(name))throw new ConfigurationError(`Unsupported [authorization] option '${name}'`);
 if(reader.hasSection('ldap'))throw new ConfigurationError('LDAP authorization is not implemented');
 const section=reader.section('authorization');let source=section.get('default_source',{defaultValue:'moonraker'}).toLowerCase();
 if(source!=='moonraker'&&source!=='ldap'){reader.warn("[authorization]: invalid default_source, falling back to moonraker");source='moonraker';}
 if(source==='ldap')throw new ConfigurationError('LDAP authorization is not implemented');
 const maximum=section.getInt('max_login_attempts',{defaultValue:null,above:0});
 const trusted=section.getList('trusted_clients',{defaultValue:[]}).flatMap(line=>line.split(',')).map(value=>value.trim()).filter(Boolean);try{new TrustedClients(trusted);}catch(error){throw new ConfigurationError(String(error));}
 const domains=section.getList('cors_domains',{defaultValue:[]});let cors:CorsPolicy|undefined;
 if(domains.length)try{cors=new CorsPolicy(domains,trusted,message=>reader.warn(message));}catch(error){throw new ConfigurationError(String(error));}
 return {...cors?{cors}:{},...trusted.length?{trustedClients:trusted}:{},issuer,loginTimeoutDays:section.getInt('login_timeout',{defaultValue:90,minval:1,maxval:3650}),forceLogins:section.getBoolean('force_logins',{defaultValue:false}),enableApiKey:section.getBoolean('enable_api_key',{defaultValue:true}),...(maximum===null?{}:{maxLoginAttempts:maximum})};
}
