import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
import {ldapPeer,ldapEntry,ldapResult} from './helpers/ldap-peer.ts';
const information={connected:false,state:'disconnected' as const,components:['application'],failedComponents:[],directories:[],warnings:[],version:'configured-ldap',missingRequirements:[]};
const authorization={issuer:'http://printer.test:7125'};
const config=(port:number,extra='')=>`[server]\nhost: 127.0.0.1\nport: 0\n[authorization]\ndefault_source: ldap\n[ldap]\nldap_host: 127.0.0.1\nldap_port: ${port}\nbase_dn: dc=test\nbind_dn: cn=service,dc=test\nbind_password: synthetic-config-private\n${extra}`;
test('standard authorized server assembles actual directory identity, redacts public config and persists JWT after restart',{timeout:10000},async()=>{
 const peer=await ldapPeer({handle(packet){if(packet.tag===96){const password=packet.fields[2]!.value.toString();ldapResult(packet,password==='synthetic-config-private'||password==='synthetic-user-private'?0:49);}else{ldapEntry(packet,'uid=printer,dc=test');ldapResult(packet);}}}),root=await mkdtemp(join(tmpdir(),'configured-ldap-')),filename=join(root,'main.conf'),path=join(root,'users.sqlite');let db=await DatabaseStore.open({path}),server:ConfiguredMoonraker|undefined;
 try{
  await writeFile(filename,config(peer.port));server=await ConfiguredMoonraker.loadAuthorized(filename,{information,database:db,authorization});const key=server.authorization!.localApiKey(),address=await server.start(),url=`http://127.0.0.1:${address.port}`;
  const access:any=await(await fetch(url+'/access/info')).json();assert.deepEqual(access.result.available_sources,['moonraker','ldap']);assert.equal(access.result.default_source,'ldap');
  const response=await fetch(url+'/access/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'printer',password:'synthetic-user-private'})});assert.equal(response.status,200);const login:any=await response.json();assert.equal(login.result.source,'ldap');const token=login.result.token;
  const settings:any=await(await fetch(url+'/server/config',{headers:{'x-api-key':key}})).json();assert(!JSON.stringify(settings).includes('synthetic-config-private'));assert(!JSON.stringify(settings).includes('synthetic-user-private'));
  server.setInformation(information);const info:any=await(await fetch(url+'/server/info',{headers:{authorization:'Bearer '+token}})).json();assert(info.result.components.includes('ldap'));assert(info.result.components.includes('authorization'));assert.deepEqual(info.result.warnings,[]);
  await server.close();assert.equal(db.status.closed,true);await writeFile(filename,'[server]\nhost: 127.0.0.1\nport: 0\n');db=await DatabaseStore.open({path});server=await ConfiguredMoonraker.loadAuthorized(filename,{information,database:db,authorization});const restarted=await server.start(),accepted=await fetch(`http://127.0.0.1:${restarted.port}/server/info`,{headers:{authorization:'Bearer '+token}});assert.equal(accepted.status,200);await accepted.arrayBuffer();
 }finally{await server?.close();await db.close();await peer.close();await rm(root,{recursive:true,force:true});}
});
test('configured LDAP shutdown aborts pending directory sockets before waiting for HTTP or database cleanup',{timeout:10000},async()=>{
 const started=Promise.withResolvers<void>(),peer=await ldapPeer({handle(){started.resolve();}}),root=await mkdtemp(join(tmpdir(),'configured-ldap-close-')),filename=join(root,'main.conf'),db=await DatabaseStore.open({path:join(root,'users.sqlite')});let server:ConfiguredMoonraker|undefined;
 try{
  await writeFile(filename,config(peer.port));server=await ConfiguredMoonraker.loadAuthorized(filename,{information,database:db,authorization});const address=await server.start(),request=fetch(`http://127.0.0.1:${address.port}/access/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'printer',password:'synthetic-user-private'})}).then(response=>response.arrayBuffer(),()=>{});
  await started.promise;const before=performance.now();await server.close();assert(performance.now()-before<1500);await request;assert.equal(db.status.closed,true);assert.equal(server.rpc.has('access.login'),false);
 }finally{await server?.close();await db.close();await peer.close();await rm(root,{recursive:true,force:true});}
});
test('LDAP configuration/template rejection retains caller database and sends no directory traffic',{timeout:10000},async()=>{
 const peer=await ldapPeer(),root=await mkdtemp(join(tmpdir(),'configured-ldap-reject-')),filename=join(root,'main.conf'),db=await DatabaseStore.open({path:join(root,'users.sqlite')});
 try{
  await writeFile(filename,config(peer.port,'user_filter: {unowned}\n'));await assert.rejects(ConfiguredMoonraker.loadAuthorized(filename,{information,database:db,authorization}));assert.equal(db.status.closed,false);assert.equal(peer.connections,0);
  await writeFile(filename,config(peer.port,'unknown: rule\n'));await assert.rejects(ConfiguredMoonraker.loadAuthorized(filename,{information,database:db,authorization}));assert.equal(db.status.closed,false);assert.equal(peer.connections,0);
  await writeFile(filename,config(peer.port,'group_dn: \n'));await assert.rejects(ConfiguredMoonraker.loadAuthorized(filename,{information,database:db,authorization}));assert.equal(db.status.closed,false);assert.equal(peer.connections,0);
 }finally{await db.close();await peer.close();await rm(root,{recursive:true,force:true});}
});
