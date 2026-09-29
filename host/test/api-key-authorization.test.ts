import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {ApiKeyAuthorization} from '../src/moonraker/api-key-authorization.ts';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
const info={connected:false,state:'disconnected' as const,components:[],failedComponents:[],directories:[],warnings:[],version:'auth-test',missingRequirements:[]};
const call=async(ws:WebSocket,method:string,params={})=>{const reply=once(ws,'message');ws.send(JSON.stringify({jsonrpc:'2.0',id:1,method,params}));return JSON.parse(String((await reply)[0]));};
test('durable native API keys protect HTTP and WebSocket; rotation revokes old sessions and survives restart',async()=>{
 const root=await mkdtemp(join(tmpdir(),'api-key-auth-')),path=join(root,'auth.sqlite'),config=join(root,'moonraker.conf');let database:DatabaseStore|undefined,auth:ApiKeyAuthorization|undefined,server:ConfiguredMoonraker|undefined,ws:WebSocket|undefined;
 try{
  await writeFile(config,'[server]\nhost: 127.0.0.1\nport: 0\n');database=await DatabaseStore.open({path});auth=await ApiKeyAuthorization.open(database);const original=auth.localApiKey();
  await assert.rejects(ApiKeyAuthorization.open(database),/already registered/);
  await assert.rejects(database.api('GET','native_authorization','api_key'),/Forbidden|forbidden|access/i);
  server=await ConfiguredMoonraker.load(config,{information:info,...auth.networkOptions});auth.register(server.endpoints);const address=await server.start(),url=`http://127.0.0.1:${address.port}`;
  const read=async(path:string,key?:string,method='GET')=>{const response=await fetch(url+path,{method,headers:key?{'x-api-key':key}:{}});return {status:response.status,body:await response.json() as any};};
  assert.equal((await read('/access/api_key')).status,401);assert.equal((await read('/access/api_key','0'.repeat(32))).status,401);
  assert.equal((await read('/access/api_key',original)).body.result,original);assert.equal((await read('/access/info')).body.result.trusted,false);
  const bearer=await fetch(url+'/access/api_key',{headers:{authorization:'Bearer unsupported','x-api-key':original}});assert.equal(bearer.status,401);await bearer.arrayBuffer();
  ws=new WebSocket(url.replace('http:','ws:')+'/websocket');await once(ws,'open');assert((await call(ws,'server.websocket.id')).error);
  const identified=await call(ws,'server.connection.identify',{client_name:'native-client',version:'1',type:'web',url:'https://example.test',api_key:original});assert(identified.result.connection_id);assert.equal((await call(ws,'access.get_api_key')).result,original);
  const rotation=await read('/access/api_key',original,'POST'),next=rotation.body.result;assert.equal(rotation.status,200);assert.match(next,/^[a-f0-9]{32}$/);assert.notEqual(next,original);
  assert.equal((await read('/access/api_key',original)).status,401);assert((await call(ws,'access.get_api_key')).error);assert.equal((await read('/access/api_key',next)).body.result,next);
  ws.terminate();ws=undefined;await server.close();server=undefined;await auth.close();await database.close();database=await DatabaseStore.open({path});auth=await ApiKeyAuthorization.open(database);assert.equal(auth.localApiKey(),next);
  await auth.close();assert.throws(()=>auth!.localApiKey(),/unavailable/);
 }finally{ws?.terminate();await server?.close();await auth?.close();await database?.close();await rm(root,{recursive:true,force:true});}
});
test('rotation is exclusive and corrupt persisted keys fail instead of resetting credentials',async()=>{
 const root=await mkdtemp(join(tmpdir(),'api-key-state-')),path=join(root,'auth.sqlite');let db=await DatabaseStore.open({path}),auth=await ApiKeyAuthorization.open(db);
 try{const first=auth.rotate();assert.throws(()=>auth.rotate(),/in progress/);const next=await first;assert.equal(auth.localApiKey(),next);await db.insert('native_authorization','api_key','corrupt');await auth.close();await db.close();db=await DatabaseStore.open({path});await assert.rejects(ApiKeyAuthorization.open(db),/Invalid persisted/);}finally{await auth.close();await db.close();await rm(root,{recursive:true,force:true});}
});
test('persistence failure closes authorization rather than serving an uncertain key',async()=>{
 const root=await mkdtemp(join(tmpdir(),'api-key-failure-')),db=await DatabaseStore.open({path:join(root,'auth.sqlite')}),auth=await ApiKeyAuthorization.open(db),insert=db.insert;
 try{db.insert=async()=>{throw Error('injected persistence failure');};await assert.rejects(auth.rotate(),/persistence failure/);assert.throws(()=>auth.localApiKey(),/unavailable/);assert.throws(()=>auth.rotate(),/unavailable/);}finally{db.insert=insert;await auth.close();await db.close();await rm(root,{recursive:true,force:true});}
});
