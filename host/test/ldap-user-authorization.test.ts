import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {LocalUserAuthorization,type LdapAuthenticator} from '../src/moonraker/local-user-authorization.ts';
import {ApiError} from '../src/moonraker/rpc.ts';
const signal=()=>new AbortController().signal;
const issuer='http://printer.test';
const denied=(status:number)=>((error:unknown)=>error instanceof ApiError&&error.status===status);
async function fixture(run:(path:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'ldap-identities-'));try{await run(join(root,'users.sqlite'));}finally{await rm(root,{recursive:true,force:true});}}
test('LDAP first login persists identity without local password and retains JWT lifecycle after restart',()=>fixture(async path=>{
 let calls=0;const ldap:LdapAuthenticator={async authenticate(name,password){calls++;assert.equal(name,'directory-user');assert.equal(password,'synthetic-directory-password');}};
 let db=await DatabaseStore.open({path}),users=await LocalUserAuthorization.open(db,{issuer,ldap,defaultSource:'ldap'});
 try{
  assert.deepEqual(users.availableSources,['moonraker','ldap']);assert.equal(users.defaultSource,'ldap');
  let events=0;const login=await users.login({username:'directory-user',password:'synthetic-directory-password'},signal(),false,()=>events++);
  assert.equal(login.source,'ldap');assert.equal(login.action,'user_logged_in');assert.equal(events,0);assert.equal(users.decode(login.token).username,'directory-user');
  const rows=await db.get('native_users',['users']) as any;
  assert.equal(rows[0].source,'ldap');assert.equal(rows[0].password,'');assert.equal(rows[0].salt,'');assert(!JSON.stringify(rows).includes('synthetic-directory-password'));
  await users.close();await db.close();db=await DatabaseStore.open({path});users=await LocalUserAuthorization.open(db,{issuer,ldap,defaultSource:'ldap'});
  assert.equal(users.decode(login.token).username,'directory-user');assert.equal(users.refresh(login.refresh_token).source,'ldap');
  const again=await users.login({username:'directory-user',password:'synthetic-directory-password',source:'LDAP'},signal());assert.equal(calls,2);assert.equal(users.count,1);
  await users.logout('directory-user',signal());assert.throws(()=>users.decode(again.token),denied(401));assert.throws(()=>users.refresh(again.refresh_token),denied(401));
  const last=await users.login({username:'directory-user',password:'synthetic-directory-password'},signal());await users.delete('directory-user','other-user',signal());assert.throws(()=>users.decode(last.token),denied(401));assert.equal(users.count,0);
 }finally{await users.close();await db.close();}
}));
test('LDAP identity cannot bypass source matching, use local password reset or explicit user creation',()=>fixture(async path=>{
 let calls=0;const db=await DatabaseStore.open({path}),users=await LocalUserAuthorization.open(db,{issuer,defaultSource:'ldap',ldap:{async authenticate(){calls++;}}});
 try{
  assert.throws(()=>users.login({username:'directory-user',password:'pass'},signal(),true),denied(400));assert.equal(calls,0);
  const local=await users.login({username:'local-user',password:'local-pass',source:'moonraker'},signal(),true);assert.equal(local.source,'moonraker');
  await assert.rejects(users.login({username:'local-user',password:'remote-pass'},signal()),denied(401));assert.equal(calls,1);assert.equal(users.count,1);
  const directory=await users.login({username:'directory-user',password:'remote-pass'},signal());
  await assert.rejects(users.login({username:'directory-user',password:'remote-pass',source:'moonraker'},signal()),denied(401));
  await assert.rejects(users.password('directory-user',{password:'remote-pass',new_password:'new'},signal()),denied(400));assert.equal(users.decode(directory.token).username,'directory-user');
  assert.throws(()=>users.login({username:'someone',password:'pass',source:'unknown'},signal()),denied(400));
 }finally{await users.close();await db.close();}
}));
test('directory failures are private and create neither identity nor token',()=>fixture(async path=>{
 const db=await DatabaseStore.open({path}),users=await LocalUserAuthorization.open(db,{issuer,ldap:{async authenticate(){throw Error('synthetic-private-password and bind secret');}}});
 try{await assert.rejects(users.login({username:'denied',password:'synthetic-private-password',source:'ldap'},signal()),error=>error instanceof ApiError&&error.status===401&&!JSON.stringify(error).includes('synthetic-private-password')&&!error.message.includes('bind secret'));assert.equal(users.count,0);}
 finally{await users.close();await db.close();}
}));
test('cancellation and close release serialized directory work even when a provider completes late',()=>fixture(async path=>{
 let release:()=>void=()=>{},started:()=>void=()=>{};let began=new Promise<void>(resolve=>started=resolve);
 const db=await DatabaseStore.open({path}),users=await LocalUserAuthorization.open(db,{issuer,ldap:{async authenticate(){started();await new Promise<void>(resolve=>release=resolve);}}});
 try{
  const controller=new AbortController(),pending=users.login({username:'cancelled',password:'pass',source:'ldap'},controller.signal);const rejection=assert.rejects(pending,error=>error===controller.signal.reason);await began;controller.abort();await rejection;assert.equal(users.count,0);release();
  began=new Promise<void>(resolve=>started=resolve);const held=users.login({username:'closed',password:'pass',source:'ldap'},signal());const closingRejection=assert.rejects(held,denied(503));await began;await users.close();await closingRejection;release();
  assert.equal(await db.namespaceContains('native_users',['users']),false);
 }finally{release();await users.close();await db.close();}
}));
test('LDAP persistence corruption fails closed; valid LDAP JWTs remain usable when directory login is disabled',()=>fixture(async path=>{
 let db=await DatabaseStore.open({path}),users=await LocalUserAuthorization.open(db,{issuer,ldap:{async authenticate(){}}});
 try{
  const login=await users.login({username:'directory-user',password:'pass',source:'ldap'},signal());await users.close();await db.close();db=await DatabaseStore.open({path});users=await LocalUserAuthorization.open(db,{issuer});
  assert.deepEqual(users.availableSources,['moonraker']);assert.equal(users.decode(login.token).username,'directory-user');assert.throws(()=>users.login({username:'directory-user',password:'pass',source:'ldap'},signal()),denied(401));
  const rows=await db.get('native_users',['users']) as any;rows[0].password='0'.repeat(64);await users.close();await db.insert('native_users',['users'],rows);await db.close();db=await DatabaseStore.open({path});await assert.rejects(LocalUserAuthorization.open(db,{issuer}),error=>error instanceof ApiError&&error.status===500&&error.message==='Invalid persisted user');
  await assert.rejects(LocalUserAuthorization.open(db,{issuer,defaultSource:'ldap'}),denied(400));
 }finally{await users.close();await db.close();}
}));
test('failed durable LDAP creation cannot issue identity or tokens',()=>fixture(async path=>{
 const db=await DatabaseStore.open({path}),users=await LocalUserAuthorization.open(db,{issuer,ldap:{async authenticate(){}}}),insert=db.insert;
 try{db.insert=async()=>{throw Error('injected directory identity commit failure');};await assert.rejects(users.login({username:'directory-user',password:'pass',source:'ldap'},signal()),/identity commit failure/);assert.throws(()=>users.list(),denied(503));assert.equal(await db.namespaceContains('native_users',['users']),false);}
 finally{db.insert=insert;await users.close();await db.close();}
}));
test('directory authentication and durable identity publication remain serialized',()=>fixture(async path=>{
 const calls:string[]=[];let release:()=>void=()=>{},began:()=>void=()=>{};const firstStarted=new Promise<void>(resolve=>began=resolve);
 const db=await DatabaseStore.open({path}),users=await LocalUserAuthorization.open(db,{issuer,ldap:{async authenticate(name){calls.push(name);if(name==='first'){began();await new Promise<void>(resolve=>release=resolve);}}}});
 try{
  const first=users.login({username:'first',password:'pass',source:'ldap'},signal()),second=users.login({username:'second',password:'pass',source:'ldap'},signal());await firstStarted;assert.deepEqual(calls,['first']);release();const results=await Promise.all([first,second]);assert.deepEqual(calls,['first','second']);assert.equal(users.count,2);for(const result of results)assert.equal(users.decode(result.token).username,result.username);
 }finally{release();await users.close();await db.close();}
}));
