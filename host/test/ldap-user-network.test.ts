import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {ApiKeyAuthorization} from '../src/moonraker/api-key-authorization.ts';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';

// Directory decision is injected here. These cases validate real native HTTP,
// WebSocket and durable identity paths, not LDAP wire/TLS or official clients.
test('native HTTP and WebSocket expose directory policy and preserve source-owned sessions',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ldap-network-')),db=await DatabaseStore.open({path:join(root,'users.sqlite')});
 const auth=await ApiKeyAuthorization.open(db,{issuer:'http://printer.test',defaultSource:'ldap',forceLogins:true,ldap:{async authenticate(name,password){if(name!=='directory-user'||password!=='synthetic-directory-password')throw Error('synthetic-private-bind-secret');}}});
 let server:ConfiguredMoonraker|undefined,socket:WebSocket|undefined;
 try{
  const filename=join(root,'moonraker.conf');await writeFile(filename,'[server]\nhost: 127.0.0.1\nport: 0\n');
  server=await ConfiguredMoonraker.load(filename,{information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'ldap-owner-test',missingRequirements:[]},...auth.networkOptions});auth.register(server.endpoints);const address=await server.start(),url='http://127.0.0.1:'+address.port;
  const http=async(path:string,body?:object,token?:string,key?:string)=>{const response=await fetch(url+path,{method:body?'POST':'GET',headers:{...body?{'content-type':'application/json'}:{},...token?{authorization:'Bearer '+token}:{},...key?{'x-api-key':key}:{}},...body?{body:JSON.stringify(body)}:{}});return {status:response.status,body:await response.json() as any};};
  const policy=(await http('/access/info')).body.result;assert.equal(policy.default_source,'ldap');assert.deepEqual(policy.available_sources,['moonraker','ldap']);assert.equal(policy.login_required,false);
  const denied=await http('/access/login',{username:'denied',password:'pass'});assert.equal(denied.status,401);assert(!JSON.stringify(denied.body).includes('synthetic-private-bind-secret'));
  const signed=await http('/access/login',{username:'directory-user',password:'synthetic-directory-password'});assert.equal(signed.status,200);const login=signed.body.result;assert.equal(login.source,'ldap');assert.equal(login.action,'user_logged_in');
  assert.equal((await http('/access/info')).body.result.login_required,true);assert.equal((await http('/access/user',undefined,login.token)).body.result.source,'ldap');
  const rows=await http('/access/users/list',undefined,undefined,auth.localApiKey());assert.deepEqual(rows.body.result.users.map((value:any)=>[value.username,value.source]),[['directory-user','ldap']]);
  assert.equal((await http('/access/user',{username:'new-directory-user',password:'pass'},undefined,auth.localApiKey())).status,400);
  assert.equal((await http('/access/user/password',{password:'synthetic-directory-password',new_password:'new'},login.token)).status,400);
  socket=new WebSocket(url.replace('http:','ws:')+'/websocket');await once(socket,'open');
  const call=async(method:string,params={})=>{const reply=once(socket!,'message');socket!.send(JSON.stringify({jsonrpc:'2.0',id:1,method,params}));return JSON.parse(String((await reply)[0]));};
  assert.equal((await call('access.info')).result.default_source,'ldap');assert.equal((await call('access.login',{username:'directory-user',password:'synthetic-directory-password'})).result.source,'ldap');
  assert.equal((await call('access.get_user')).result.source,'ldap');assert.equal((await call('access.logout')).result.action,'user_logged_out');assert((await call('access.get_user')).error);
  assert.equal((await http('/access/user',undefined,login.token)).status,401);assert.equal((await http('/access/refresh_jwt',{refresh_token:login.refresh_token})).status,401);
 }finally{socket?.terminate();await server?.close();await auth.close();await db.close();await rm(root,{recursive:true,force:true});}
});
