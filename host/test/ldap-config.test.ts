import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource,ConfigurationError} from '../src/moonraker/config-source.ts';
import {readLdapOptions} from '../src/moonraker/ldap-config.ts';
import {readAuthorizationOptions} from '../src/moonraker/authorization-config.ts';
import {LdapAuthorization} from '../src/moonraker/ldap-authorization.ts';
import {ApiError} from '../src/moonraker/rpc.ts';
const reader=(ldap:Record<string,string>,authorization:Record<string,string>={})=>new ConfigurationReader(new ConfigurationSource('/config/main.conf',{server:{},ldap,authorization},[]));
test('LDAP configuration consumes pinned option defaults and keeps direct credentials out of public copies',async()=>{
 const source=reader({ldap_host:'directory.test',base_dn:'dc=test',bind_dn:'cn=service,dc=test',bind_password:'synthetic-private-config'}),options=await readLdapOptions(source);
 assert.deepEqual(options,{host:'directory.test',secure:false,baseDn:'dc=test',bindDn:'cn=service,dc=test',bindPassword:'synthetic-private-config',membershipAttribute:'memberOf',checkDnCase:true,activeDirectory:false});
 const ldap=new LdapAuthorization(options);
 try{
  const policy=readAuthorizationOptions(source,'http://printer.test',ldap);assert.equal(policy.defaultSource,'moonraker');assert.equal(policy.ldap,ldap);
  assert.equal(source.section('ldap').get('bind_password'),'synthetic-private-config');assert.equal(source.source.original.ldap.bind_password,'synthetic-private-config');
  for(const value of [source.snapshot(),source.parsed()])assert(!JSON.stringify(value).includes('synthetic-private-config'));
  assert.equal(source.snapshot().original.ldap.bind_password,'<redacted>');assert.equal(source.parsed().ldap.bind_password,'<redacted>');assert.deepEqual(source.validate(),[]);
 }finally{await ldap.close();}
});
test('LDAP templates render all private fields asynchronously and publish only source placeholders',async()=>{
 const raw={ldap_host:'directory.test',ldap_port:'1636',ldap_secure:'yes',base_dn:'{base}',group_dn:'{group}',bind_dn:'{bind}',bind_password:'{password}',user_filter:'{filter}',membership_attribute:'isMemberOf',check_dn_case:'false',is_active_directory:'true'},source=reader(raw,{default_source:'LDAP'}),seen:string[]=[],values:Record<string,string>={'{base}':'  dc=test\n','{group}':'cn=printers,dc=test','{bind}':'cn=service,dc=test','{password}':' synthetic-resolved-secret ','{filter}':'(uid=USERNAME)'};
 const options=await readLdapOptions(source,{render:async(source,signal)=>{signal.throwIfAborted();seen.push(source);await Promise.resolve();return values[source]!;},ca:'synthetic-ca'});
 assert.deepEqual(seen,['{base}','{group}','{bind}','{password}','{filter}']);assert.equal(options.bindPassword,'synthetic-resolved-secret');assert.equal(options.baseDn,'dc=test');assert.equal(options.port,1636);assert.equal(options.secure,true);assert.equal(options.membershipAttribute,'isMemberOf');assert.equal(options.checkDnCase,false);assert.equal(options.activeDirectory,true);assert.equal(options.ca,'synthetic-ca');
 const ldap=new LdapAuthorization(options);try{assert.equal(readAuthorizationOptions(source,'http://printer.test',ldap).defaultSource,'ldap');assert(!JSON.stringify(source.snapshot()).includes('synthetic-resolved-secret'));assert.equal(source.snapshot().original.ldap.bind_password,'<redacted>');}finally{await ldap.close();}
});
test('LDAP rejects unknown, invalid and unowned template configuration before creating a directory owner',async()=>{
 const invalid:Record<string,string>[]=[{unknown:'private'},{ldap_port:'0'},{ldap_secure:'perhaps'},{membership_attribute:'other'},{bind_dn:'cn=service'},{base_dn:'{unowned}'},{user_filter:'(uid=someone)'}];
 for(const fields of invalid)await assert.rejects(readLdapOptions(reader({ldap_host:'directory.test',base_dn:'dc=test',...fields})),ConfigurationError);
 const source=reader({ldap_host:'directory.test',base_dn:'{private}'});await assert.rejects(readLdapOptions(source,{render:()=>{throw Error('synthetic-private-value');}}),error=>error instanceof ConfigurationError&&!error.message.includes('synthetic-private-value')&&!error.cause);
 await assert.rejects(readLdapOptions(source,{render:()=>123 as any}),ConfigurationError);
 await assert.rejects(readLdapOptions(source,{render:()=>'\0private'}),ConfigurationError);
 assert.throws(()=>readAuthorizationOptions(source,'http://printer.test'),/directory owner/);
 const without=new ConfigurationReader(new ConfigurationSource('/config/main.conf',{server:{},authorization:{}},[])),ldap=new LdapAuthorization({host:'directory.test',baseDn:'dc=test'});try{assert.throws(()=>readAuthorizationOptions(without,'http://printer.test',ldap),/directory owner/);}finally{await ldap.close();}
});
test('LDAP template cancellation releases waiting configuration and ignores late results',async()=>{
 const started=Promise.withResolvers<void>(),late=Promise.withResolvers<string>(),controller=new AbortController(),source=reader({ldap_host:'directory.test',base_dn:'{private}'});
 const pending=readLdapOptions(source,{signal:controller.signal,render:(_source,signal)=>{assert.equal(signal.aborted,false);started.resolve();return late.promise;}}),rejected=assert.rejects(pending,error=>error===controller.signal.reason);
 await started.promise;controller.abort();await rejected;late.resolve('dc=late');await Promise.resolve();assert(!JSON.stringify(source.snapshot()).includes('dc=late'));
});
test('public redaction never reads inherited constructor or prototype sections',()=>{
 const source=new ConfigurationReader(new ConfigurationSource('/config/main.conf',{server:{}},[]));
 source.redact('constructor','prototype');source.redact('__proto__','__proto__');
 const original=Object.getPrototypeOf(Object.prototype);assert.deepEqual(source.parsed(),{server:{}});assert.deepEqual(source.snapshot().original,{server:{}});assert.equal(Object.getPrototypeOf(Object.prototype),original);
 const own=Object.create(null);own.server={};own.ldap=Object.assign(Object.create(null),{bind_password:'synthetic-own-password'});Object.defineProperty(own,'__proto__',{value:Object.assign(Object.create(null),{private:'synthetic-prototype-value'}),enumerable:true});
 const declared=new ConfigurationReader(new ConfigurationSource('/config/main.conf',own,[]));declared.redact('ldap','bind_password');declared.redact('__proto__','private');const snapshot=declared.snapshot();assert.equal(snapshot.original.ldap.bind_password,'<redacted>');assert.equal(snapshot.original.__proto__.private,'<redacted>');assert.equal(declared.source.original.__proto__.private,'synthetic-prototype-value');
});
test('LDAP rejects empty group DN instead of silently disabling configured membership policy',async()=>{
 assert.throws(()=>new LdapAuthorization({host:'directory.test',baseDn:'dc=test',groupDn:''}),error=>error instanceof ApiError&&error.status===400);
 await assert.rejects(readLdapOptions(reader({ldap_host:'directory.test',base_dn:'dc=test',group_dn:''})),ConfigurationError);
 await assert.rejects(readLdapOptions(reader({ldap_host:'directory.test',base_dn:'dc=test',group_dn:'{group}'}),{render:source=>source==='{group}'?'\n ':'dc=test'}),ConfigurationError);
 const absent=await readLdapOptions(reader({ldap_host:'directory.test',base_dn:'dc=test'}));assert.equal(absent.groupDn,undefined);
});
