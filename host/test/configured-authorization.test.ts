import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {WebSocket} from 'ws';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
const information={connected:false,state:'disconnected' as const,components:['application'],failedComponents:[],directories:[],warnings:[],version:'configured-auth',missingRequirements:[]};
const authorization={issuer:'http://printer.test:7125'};
test('configuration-owned authorization registers routes and events, publishes policy, and persists across restart',async()=>{
 const root=await mkdtemp(join(tmpdir(),'configured-auth-')),config=join(root,'main.conf'),policy=join(root,'auth.conf'),path=join(root,'auth.sqlite');let db=await DatabaseStore.open({path}),server:ConfiguredMoonraker|undefined,ws:WebSocket|undefined;
 try{
  await writeFile(config,'[server]\nhost: 127.0.0.1\nport: 0\n[include auth.conf]\n');await writeFile(policy,'[authorization]\nlogin_timeout: 1\nforce_logins: true\nmax_login_attempts: 1\n');
  server=await ConfiguredMoonraker.loadAuthorized(config,{information,database:db,authorization});assert.equal(server.status.phase,'new');const key=server.authorization!.localApiKey(),address=await server.start(),url=`http://127.0.0.1:${address.port}`;
  const post=async(route:string,body:object,headers:Record<string,string>={})=>{const response=await fetch(url+route,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});return {status:response.status,body:await response.json() as any};};
  const denied=await fetch(url+'/server/info');assert.equal(denied.status,401);await denied.arrayBuffer();
  const configBody:any=await(await fetch(url+'/server/config',{headers:{'x-api-key':key}})).json();assert.deepEqual(configBody.result.config.authorization,{default_source:'moonraker',max_login_attempts:1,login_timeout:1,force_logins:true,enable_api_key:true});assert(!JSON.stringify(configBody).includes(key));
  server.setInformation(information);
  const state:any=await(await fetch(url+'/server/info',{headers:{'x-api-key':key}})).json();assert(state.result.components.includes('authorization'));assert.equal(state.result.warnings.length,0);
  ws=new WebSocket(url.replace('http:','ws:')+'/websocket',{headers:{'x-api-key':key}});await once(ws,'open');const notification=once(ws,'message',{signal:AbortSignal.timeout(2000)});
  const created=await post('/access/user',{username:'alice',password:'pass'},{'x-api-key':key});assert.equal(created.status,200);assert.equal(JSON.parse(String((await notification)[0])).method,'notify_user_created');
  const refresh=JSON.parse(Buffer.from(created.body.result.refresh_token.split('.')[1],'base64url').toString());assert.equal(refresh.exp-refresh.iat,86400);
  const accessInfo:any=await(await fetch(url+'/access/info')).json();assert.equal(accessInfo.result.login_required,true);
  assert.equal((await post('/access/login',{username:'alice',password:'wrong'})).status,400);assert.equal((await post('/access/login',{username:'alice',password:'pass'})).status,401);
  ws.terminate();ws=undefined;const old=server.authorization!;await server.close();assert.equal(db.status.closed,true);assert.throws(()=>old.localApiKey(),/unavailable/);assert.equal(server.rpc.has('access.login'),false);
  await writeFile(policy,'[authorization]\nenable_api_key: false\nmax_login_attempts: 2\n');db=await DatabaseStore.open({path});server=await ConfiguredMoonraker.loadAuthorized(config,{information,database:db,authorization});assert.equal(server.authorization!.localApiKey(),key);const restart=await server.start(),restartUrl=`http://127.0.0.1:${restart.port}`;
  const rejected=await fetch(restartUrl+'/server/info',{headers:{'x-api-key':key}});assert.equal(rejected.status,401);await rejected.arrayBuffer();
  const login=await fetch(restartUrl+'/access/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'alice',password:'pass'})});assert.equal(login.status,200);const token=((await login.json()) as any).result.token;
  const accepted=await fetch(restartUrl+'/server/info',{headers:{authorization:'Bearer '+token}});assert.equal(accepted.status,200);await accepted.arrayBuffer();
 }finally{ws?.terminate();await server?.close();await db.close();await rm(root,{recursive:true,force:true});}
});
test('configuration rejection retains caller ownership; failed authorization initialization and listen release transferred database',async()=>{
 const root=await mkdtemp(join(tmpdir(),'configured-auth-failure-')),config=join(root,'main.conf'),path=join(root,'auth.sqlite');let db=await DatabaseStore.open({path}),server:ConfiguredMoonraker|undefined;const blocker=createServer();
 try{
  await writeFile(config,'[server]\nport: 0\n[authorization]\ntrusted_clients: 127.0.0.1\n');await assert.rejects(ConfiguredMoonraker.loadAuthorized(config,{information,database:db,authorization}),/Unsupported/);assert.equal(db.status.closed,false);
  await writeFile(config,'[server]\nhost: 127.0.0.1\nport: 0\n');await assert.rejects(ConfiguredMoonraker.loadAuthorized(config,{information,database:db,authorization,authorize:()=>{}} as any),/external/);assert.equal(db.status.closed,false);
  await db.insert('native_authorization','api_key','corrupt');await assert.rejects(ConfiguredMoonraker.loadAuthorized(config,{information,database:db,authorization}),/Invalid persisted/);assert.equal(db.status.closed,true);
  db=await DatabaseStore.open({path:join(root,'listen.sqlite')});blocker.listen(0,'127.0.0.1');await once(blocker,'listening');await writeFile(config,`[server]\nhost: 127.0.0.1\nport: ${(blocker.address() as any).port}\n`);
  server=await ConfiguredMoonraker.loadAuthorized(config,{information,database:db,authorization});await assert.rejects(server.start(),/EADDRINUSE/);assert.equal(db.status.closed,true);assert.equal(server.rpc.has('access.login'),false);assert.throws(()=>server!.authorization!.localApiKey(),/unavailable/);
 }finally{await server?.close();await db.close();if(blocker.listening)await new Promise<void>(resolve=>blocker.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
});
test('server shutdown drains in-flight authorization persistence before closing its database',async()=>{
 const root=await mkdtemp(join(tmpdir(),'configured-auth-drain-')),config=join(root,'main.conf'),path=join(root,'auth.sqlite');let db=await DatabaseStore.open({path}),server:ConfiguredMoonraker|undefined;const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 try{
  await writeFile(config,'[server]\nhost: 127.0.0.1\nport: 0\n');server=await ConfiguredMoonraker.loadAuthorized(config,{information,database:db,authorization});const key=server.authorization!.localApiKey(),address=await server.start(),insert=db.insert;
  db.insert=async(...args)=>{if(args[0]==='native_users'){entered.resolve();await release.promise;}return insert.apply(db,args);};
  const request=fetch(`http://127.0.0.1:${address.port}/access/user`,{method:'POST',headers:{'content-type':'application/json','x-api-key':key},body:JSON.stringify({username:'alice',password:'pass'})}).then(r=>r.arrayBuffer(),()=>{});
  await entered.promise;const closing=server.close();await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(db.status.closing,false);assert.equal(db.status.closed,false);release.resolve();await closing;await request;assert.equal(db.status.closed,true);
  db=await DatabaseStore.open({path});assert.equal((await db.get('native_users','users') as any[])[0].username,'alice');
 }finally{release.resolve();await server?.close();await db.close();await rm(root,{recursive:true,force:true});}
});
