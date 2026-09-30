import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {IncomingMessage} from 'node:http';
import {Socket} from 'node:net';
import {WebSocket} from 'ws';
import {createPrivateKey,sign} from 'node:crypto';
import {LocalUserAuthorization} from '../src/moonraker/local-user-authorization.ts';
import {ApiKeyAuthorization} from '../src/moonraker/api-key-authorization.ts';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
const signal=()=>new AbortController().signal;
const info={connected:false,state:'disconnected' as const,components:[],failedComponents:[],directories:[],warnings:[],version:'user-test',missingRequirements:[]};
const call=async(ws:WebSocket,method:string,params={})=>{const reply=once(ws,'message');ws.send(JSON.stringify({jsonrpc:'2.0',id:1,method,params}));return JSON.parse(String((await reply)[0]));};
test('local JWT claims, password changes, persisted revocation and independent users',async()=>{
 const root=await mkdtemp(join(tmpdir(),'local-users-')),path=join(root,'auth.sqlite');let db=await DatabaseStore.open({path}),now=10000;
 const options={issuer:'http://printer.test:7125',now:()=>now};let users=await LocalUserAuthorization.open(db,options);
 try{
  const a=await users.login({username:'alice',password:'old'},signal(),true),b=await users.login({username:'bob',password:'other'},signal(),true);
  assert.deepEqual(users.decode(a.token),{username:'alice'});assert.throws(()=>users.decode(a.refresh_token),/Invalid/);assert.throws(()=>users.refresh(a.token),/Invalid/);
  assert.throws(()=>users.decode(a.token.slice(0,-4)+'AAAA'),/Invalid/);
  await assert.rejects(db.api('GET','native_users','users'),/Forbidden|forbidden|access/i);
  const rows=await db.get('native_users','users') as any[],row=rows.find(x=>x.username==='alice');
  assert.notEqual(row.password,'old');
  const key=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(row.jwt_secret,'hex')]),format:'der',type:'pkcs8'});
  const signed=(change:object)=>{const parts=a.token.split('.'),payload={...JSON.parse(Buffer.from(parts[1],'base64url').toString()),...change},message=parts[0]+'.'+Buffer.from(JSON.stringify(payload)).toString('base64url');return message+'.'+sign(null,Buffer.from(message),key).toString('base64url');};
  for(const change of [{iss:'http://other.test'},{aud:'other'},{token_type:'refresh'},{exp:9999},{username:'bob'},{iat:0.1}])assert.throws(()=>users.decode(signed(change)),/Invalid/);
  now=13600;assert.equal(users.decode(a.token).username,'alice');now++;assert.throws(()=>users.decode(a.token),/expired/);
  assert.equal(users.decode(a.token,'access',false).username,'alice');
  const fresh=users.refresh(a.refresh_token);assert.equal(users.decode(fresh.token).username,'alice');
  await users.password('alice',{password:'old',new_password:'new'},signal());
  await assert.rejects(users.login({username:'alice',password:'old'},signal()),/Password/);
  assert.equal(users.decode(fresh.token).username,'alice');
  const logged=await users.login({username:'alice',password:'new'},signal());
  await users.close();await db.close();db=await DatabaseStore.open({path});users=await LocalUserAuthorization.open(db,options);
  assert.equal(users.decode(logged.token).username,'alice');await users.logout('alice',signal());
  assert.throws(()=>users.decode(logged.token),/Invalid/);assert.throws(()=>users.refresh(logged.refresh_token),/Invalid/);
  assert.equal(users.refresh(b.refresh_token).username,'bob');
  await users.close();await db.close();db=await DatabaseStore.open({path});users=await LocalUserAuthorization.open(db,options);
  assert.throws(()=>users.refresh(logged.refresh_token),/Invalid/);
  assert.throws(()=>users.delete('bob','bob',signal()),/Cannot delete/);
  await users.delete('bob','alice',signal());assert.throws(()=>users.refresh(b.refresh_token),/Invalid/);
 }finally{await users.close();await db.close();await rm(root,{recursive:true,force:true});}
});
test('HTTP and WebSocket user journeys enforce session revocation and subscription identity',async()=>{
 const root=await mkdtemp(join(tmpdir(),'user-network-')),db=await DatabaseStore.open({path:join(root,'auth.sqlite')}),auth=await ApiKeyAuthorization.open(db,{issuer:'http://printer.test',forceLogins:true});let server:ConfiguredMoonraker|undefined;const sockets:WebSocket[]=[];
 try{
  const config=join(root,'moonraker.conf');await writeFile(config,'[server]\nhost: 127.0.0.1\nport: 0\n');server=await ConfiguredMoonraker.load(config,{information:info,...auth.networkOptions});auth.register(server.endpoints);const address=await server.start(),url=`http://127.0.0.1:${address.port}`;
  const http=async(path:string,method='GET',body?:object,token?:string,key?:string)=>{const r=await fetch(url+path,{method,headers:{...(body?{'content-type':'application/json'}:{}),...(token?{authorization:'Bearer '+token}:{}),...(key?{'x-api-key':key}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json() as any};};
  assert.equal((await http('/access/user','POST',{username:'alice',password:'pass'})).status,401);
  const a=(await http('/access/user','POST',{username:'alice',password:'pass'},undefined,auth.localApiKey())).body.result;
  assert.equal(a.username,'alice');assert.equal((await http('/access/info')).body.result.login_required,true);
  const b=(await http('/access/user','POST',{username:'bob',password:'pass'},a.token)).body.result;
  assert.equal((await http('/access/user','GET',undefined,a.token)).body.result.username,'alice');
  const query=await http('/access/user?access_token='+encodeURIComponent(a.token));assert.equal(query.body.result.username,'alice');
  const alternate=await fetch(url+'/access/user',{headers:{'x-access-token':a.token}});assert.equal(alternate.status,200);await alternate.arrayBuffer();
  const ws=new WebSocket(url.replace('http:','ws:')+'/websocket');sockets.push(ws);await once(ws,'open');
  assert((await call(ws,'access.get_user')).error);assert.equal((await call(ws,'access.login',{username:'alice',password:'pass'})).result.username,'alice');
  assert.equal((await call(ws,'access.get_user')).result.username,'alice');
  assert.equal((await call(ws,'access.post_user',{username:'charlie',password:'pass'})).result.username,'charlie');
  assert.equal((await call(ws,'access.get_user')).result.username,'alice');
  const request=(token:string)=>{const req=new IncomingMessage(new Socket());req.url='/';req.headers.authorization='Bearer '+token;return req;};
  const source={request:request(a.token),transport:'http' as const,signal:signal()},target={request:request(b.token),transport:'websocket' as const,signal:signal()};
  assert.throws(()=>auth.networkOptions.authorizeSubscriptionConnection!(source,target),/identity mismatch/);
  auth.networkOptions.authorizeSubscriptionConnection!(source,{...target,request:request(a.token)});
  assert.equal((await call(ws,'access.logout')).result.action,'user_logged_out');assert((await call(ws,'access.get_user')).error);
  assert.equal((await http('/access/user','GET',undefined,a.token)).status,401);assert.equal((await http('/access/refresh_jwt','POST',{refresh_token:a.refresh_token})).status,401);
  assert.throws(()=>auth.networkOptions.authorizeNotification!('notify_status_update',[],{...source,transport:'websocket'}),/Invalid/);
  assert.equal((await call(ws,'access.login',{username:'bob',password:'pass'})).result.username,'bob');assert.equal((await call(ws,'access.get_user')).result.username,'bob');
  const refreshed=await http('/access/refresh_jwt','POST',{refresh_token:b.refresh_token});assert.equal(refreshed.body.result.username,'bob');
  const identified=new WebSocket(url.replace('http:','ws:')+'/websocket');sockets.push(identified);await once(identified,'open');
  assert((await call(identified,'server.connection.identify',{client_name:'jwt-client',version:'1',type:'web',url:'https://example.test',access_token:b.token})).result.connection_id);
  assert.equal((await call(identified,'access.get_user')).result.username,'bob');
 }finally{for(const ws of sockets)ws.terminate();await server?.close();await auth.close();await db.close();await rm(root,{recursive:true,force:true});}
});
test('failed durable user mutation fails closed and abandoned requests do not create users',async()=>{
 const root=await mkdtemp(join(tmpdir(),'user-failure-')),db=await DatabaseStore.open({path:join(root,'auth.sqlite')}),users=await LocalUserAuthorization.open(db,{issuer:'http://printer.test'}),insert=db.insert;
 try{
  const abort=new AbortController();abort.abort();assert.throws(()=>users.login({username:'cancelled',password:'pass'},abort.signal,true));assert.equal(users.count,0);
  const a=await users.login({username:'alice',password:'pass'},signal(),true);db.insert=async()=>{throw Error('injected disk failure');};
  await assert.rejects(users.logout('alice',signal()),/disk failure/);assert.throws(()=>users.decode(a.token),/unavailable/);
 }finally{db.insert=insert;await users.close();await db.close();await rm(root,{recursive:true,force:true});}
});
