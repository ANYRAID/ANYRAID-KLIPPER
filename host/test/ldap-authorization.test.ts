import {test} from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspect} from 'node:util';
import {LdapAuthorization,escapeLdapFilter} from '../src/moonraker/ldap-authorization.ts';
import {ApiError} from '../src/moonraker/rpc.ts';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {LocalUserAuthorization} from '../src/moonraker/local-user-authorization.ts';
import {ldapPeer,ldapEntry,ldapResult,type BerField} from './helpers/ldap-peer.ts';
import {mqttCertificate} from './helpers/mqtt-certificate.ts';
const signal=()=>new AbortController().signal;
const denied=(error:unknown)=>error instanceof ApiError&&error.status===401&&error.message==='LDAP authentication failed';
async function until(predicate:()=>boolean){const deadline=performance.now()+2000;while(!predicate()){if(performance.now()>deadline)throw Error('Directory fixture timed out');await new Promise(resolve=>setTimeout(resolve,2));}}
const values=(fields:BerField[]):string[]=>fields.flatMap(field=>field.fields.length?values(field.fields):field.tag===4?[field.value.toString('utf8')]:[]);
test('LDAP rejects unsafe configuration and escapes filter assertion values',()=>{
 const valid={host:'127.0.0.1',baseDn:'dc=test'};
 for(const change of [{host:'ldap://private:secret@host'},{host:'host/path'},{port:0},{timeoutMs:Infinity},{secure:'yes'},{bindDn:'cn=service'},{bindPassword:'private'},{ca:'ca'},{userFilter:'(uid=someone)'},{membershipAttribute:'typo'},{baseDn:'\0'}])assert.throws(()=>new LdapAuthorization({...valid,...change} as any),error=>error instanceof ApiError&&error.status===400);
 assert.equal(escapeLdapFilter('用户*(x)\\\0'),'用户\\2a\\28x\\29\\5c\\00');
});
test('actual LDAP service bind, subtree search and user bind feed durable JWT identities without storing directory passwords',{timeout:10000},async()=>{
 const peer=await ldapPeer({handle(packet){if(packet.tag===96){const dn=packet.fields[1]!.value.toString(),password=packet.fields[2]!.value.toString();ldapResult(packet,dn==='cn=service,dc=test'&&password==='synthetic-bind-secret'||dn==='uid=printer,dc=test'&&password==='synthetic-user-secret'?0:49,'synthetic-private-diagnostic');}else{ldapEntry(packet,'uid=printer,dc=test',{memberOf:['cn=other,dc=test','cn=printers,dc=test']});ldapResult(packet);}}});
 const directory=await mkdtemp(join(tmpdir(),'ldap-wire-users-')),ldap=new LdapAuthorization({host:'127.0.0.1',port:peer.port,baseDn:'dc=test',bindDn:'cn=service,dc=test',bindPassword:'synthetic-bind-secret',groupDn:'cn=printers,dc=test'});
 const db=await DatabaseStore.open({path:join(directory,'users.sqlite')}),users=await LocalUserAuthorization.open(db,{issuer:'http://printer.test',ldap,defaultSource:'ldap'});
 try{
  const login=await users.login({username:'printer',password:'synthetic-user-secret'},signal());assert.equal(login.source,'ldap');assert.equal(users.decode(login.token).username,'printer');
  const search=peer.packets.find(packet=>packet.tag===99)!;assert.equal(search.fields[0]!.value.toString(),'dc=test');assert.equal(search.fields[1]!.value[0],2);assert.deepEqual(values(search.fields[6]!.fields),['objectClass','Person','uid','printer']);assert.deepEqual(values(search.fields[7]!.fields),['memberOf']);
  const rows=JSON.stringify(await db.get('native_users',['users']));assert(!rows.includes('synthetic-user-secret'));assert(!rows.includes('synthetic-bind-secret'));
  await assert.rejects(users.login({username:'printer',password:'wrong'},signal()),denied);assert.equal(users.count,1);
  assert(!JSON.stringify(ldap).includes('synthetic-bind-secret'));assert(!inspect(ldap).includes('synthetic-bind-secret'));assert.deepEqual(peer.errors,[]);
 }finally{await users.close();await ldap.close();await db.close();await peer.close();await rm(directory,{recursive:true,force:true});}
});
test('LDAP wire filters support AD and all custom USERNAME substitutions without injection',{timeout:10000},async()=>{
 const peer=await ldapPeer(),name='用户*)(uid=*)\\';
 try{for(const mode of ['ad','custom']){
  const ldap=new LdapAuthorization({host:'127.0.0.1',port:peer.port,baseDn:'dc=test',...mode==='ad'?{activeDirectory:true}:{userFilter:'(|(uid=USERNAME)(mail=USERNAME))'}});
  try{await ldap.authenticate(name,'synthetic-pass',signal());const search=peer.packets.filter(packet=>packet.tag===99).at(-1)!;assert.deepEqual(values(search.fields[6]!.fields),mode==='ad'?['objectClass','Person','sAMAccountName',name]:['uid',name,'mail',name]);assert.deepEqual(values(search.fields[7]!.fields),['1.1']);}finally{await ldap.close();}
 }}finally{await peer.close();}
});
test('LDAP group policy handles single or multiple values and DN case, and denies missing users or attributes',{timeout:10000},async()=>{
 for(const mode of ['single','multiple','case','case-sensitive','missing','wrong','no-user']){
  const peer=await ldapPeer({handle(packet){if(packet.tag===96)ldapResult(packet);else{if(mode!=='no-user')ldapEntry(packet,'uid=printer,dc=test',mode==='missing'?{}:{ISMEMBEROF:mode==='multiple'?['cn=other,dc=test','cn=Printers,dc=Test']:mode==='wrong'?['cn=other,dc=test']:['cn=Printers,dc=Test']});ldapResult(packet);}}});
  const ldap=new LdapAuthorization({host:'127.0.0.1',port:peer.port,baseDn:'dc=test',groupDn:mode.startsWith('case')?'CN=printers,DC=test':'cn=Printers,dc=Test',membershipAttribute:'isMemberOf',checkDnCase:mode!=='case'});
  try{if(['case-sensitive','missing','wrong','no-user'].includes(mode))await assert.rejects(ldap.authenticate('printer','pass',signal()),denied);else await ldap.authenticate('printer','pass',signal());}finally{await ldap.close();await peer.close();}
 }
});
test('LDAP queue capacity and close reject waiting logins without creating a socket',{timeout:10000},async()=>{
 const ldap=new LdapAuthorization({host:'127.0.0.1',port:9,baseDn:'dc=test'}),pending:Promise<void>[]=[];
 for(let i=0;i<32;i++)pending.push(ldap.authenticate('printer-'+i,'pass',signal()));
 const results=Promise.allSettled(pending);assert.equal(ldap.status.pending,32);
 assert.throws(()=>ldap.authenticate('overflow','pass',signal()),error=>error instanceof ApiError&&error.status===429);
 await ldap.close();for(const result of await results){assert.equal(result.status,'rejected');assert(result.status==='rejected'&&result.reason instanceof ApiError&&result.reason.status===503);}assert.deepEqual(ldap.status,{closed:true,pending:0});
});
test('LDAP rebind fallback uses a fresh user session and refused service reconnect never searches anonymously',{timeout:10000},async()=>{
 let binds=0;const peer=await ldapPeer({handle(packet){if(packet.tag===96)ldapResult(packet,++binds===2?53:0);else{ldapEntry(packet,'uid=printer,dc=test');ldapResult(packet);}}}),ldap=new LdapAuthorization({host:'127.0.0.1',port:peer.port,baseDn:'dc=test'});
 try{await ldap.authenticate('printer','pass',signal());assert.equal(peer.connections,2);assert.equal(binds,3);assert.equal(peer.packets.filter(packet=>packet.tag===99).length,1);assert.equal(peer.packets.filter(packet=>packet.tag===96).at(-1)!.fields[1]!.value.toString(),'uid=printer,dc=test');}finally{await ldap.close();await peer.close();}
 const dropped=await ldapPeer({handle(packet){if(packet.tag===96){ldapResult(packet);packet.socket.end();}}}),refused=new LdapAuthorization({host:'127.0.0.1',port:dropped.port,baseDn:'dc=test',timeoutMs:150});
 try{await assert.rejects(refused.authenticate('printer','pass',signal()),denied);assert.equal(dropped.connections,1);}finally{await refused.close();await dropped.close();}
});
test('LDAP deadline, response byte limit, cancellation and close terminate bounded actual sockets and queued work',{timeout:10000},async()=>{
 for(const mode of ['timeout','limit','abort','close']){
  const peer=await ldapPeer({handle(packet){if(mode==='limit')packet.socket.write(Buffer.concat([Buffer.from([48,132,1,0,0,0]),Buffer.alloc(8192)]));}}),ldap=new LdapAuthorization({host:'127.0.0.1',port:peer.port,baseDn:'dc=test',timeoutMs:mode==='timeout'?80:1000,maxResponseBytes:4096}),controller=new AbortController();
  const started=performance.now(),pending=ldap.authenticate('printer','synthetic-pass',controller.signal);
  const rejection=assert.rejects(pending,mode==='abort'?error=>error===controller.signal.reason:mode==='close'?error=>error instanceof ApiError&&error.status===503:denied);
  try{
   if(mode==='abort'||mode==='close'){await until(()=>peer.packets.length===1);if(mode==='abort')controller.abort();else{const queued=ldap.authenticate('other','pass',signal()),queueRejected=assert.rejects(queued,error=>error instanceof ApiError&&error.status===503);assert.equal(peer.connections,1);await ldap.close();await queueRejected;}}
   await rejection;assert(performance.now()-started<1500);await until(()=>peer.sockets.size===0);assert.equal(peer.connections,1);
  }finally{await ldap.close();await peer.close();}
 }
});
test('LDAPS validates CA and host, supplies DNS SNI, and sends no credentials to untrusted or wrong-host peers',{timeout:15000},async()=>{
 for(const mode of ['trusted-ip','trusted-dns','untrusted','wrong-host']){
  const tls=await mqttCertificate(mode==='wrong-host'?'DNS:wrong.invalid':mode==='trusted-dns'?'DNS:localhost':'IP:127.0.0.1'),peer=await ldapPeer({tls}),ldap=new LdapAuthorization({host:mode==='trusted-dns'?'localhost':'127.0.0.1',port:peer.port,secure:true,baseDn:'dc=test',...mode==='untrusted'?{}:{ca:tls.cert},timeoutMs:2000});
  try{if(mode==='untrusted'||mode==='wrong-host'){await assert.rejects(ldap.authenticate('printer','synthetic-pass',signal()),denied);assert.equal(peer.packets.length,0);}else{await ldap.authenticate('printer','synthetic-pass',signal());assert.equal(peer.packets.filter(packet=>packet.tag===96).length,2);if(mode==='trusted-dns')assert.equal((peer.packets[0]!.socket as any).servername,'localhost');}}finally{await ldap.close();await peer.close();}
 }
});
test('oversized coalesced BER is refused before library parsing and malformed recursion cannot escape the login',{timeout:10000},async()=>{
 for(const mode of ['oversized','malformed']){
  const peer=await ldapPeer({handle(packet){if(mode==='oversized')packet.socket.write(Buffer.alloc(65536,255));else{
   // Many unsolicited minimal bind responses in one TCP write exercise the
   // library's recursive message parser; no directory credential is involved.
   const response=Buffer.from([48,12,2,1,127,97,7,10,1,0,4,0,4,0]);packet.socket.write(Buffer.concat(Array(5000).fill(response)));
  }}}),ldap=new LdapAuthorization({host:'127.0.0.1',port:peer.port,baseDn:'dc=test',timeoutMs:100,maxResponseBytes:mode==='oversized'?4096:1024*1024});
  try{await assert.rejects(ldap.authenticate('printer','pass',signal()),denied);assert.equal(peer.connections,1);await until(()=>peer.sockets.size===0);}finally{await ldap.close();await peer.close();}
 }
});
