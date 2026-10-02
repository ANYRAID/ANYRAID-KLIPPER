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
class Peer {
 readonly socket:WebSocket;readonly messages:any[]=[];#id=0;
 constructor(url:string){this.socket=new WebSocket(url);this.socket.on('message',data=>{this.messages.push(JSON.parse(String(data)));});}
 async wait(predicate:(message:any)=>boolean){const existing=this.messages.find(predicate);if(existing)return existing;return new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{cleanup();reject(Error('Expected websocket frame not received'));},2000);const cleanup=()=>{clearTimeout(timer);this.socket.off('message',received);};const received=(data:any)=>{const value=JSON.parse(String(data));if(predicate(value)){cleanup();resolve(value);}};this.socket.on('message',received);});}
 async call(method:string,params={}){const id=++this.#id;this.socket.send(JSON.stringify({jsonrpc:'2.0',id,method,params}));return this.wait(value=>value.id===id);}
 event(method:string,username:string){return this.wait(value=>value.method===method&&value.params?.[0]?.username===username);}
}
const information={connected:false,state:'disconnected' as const,components:[],failedComponents:[],directories:[],warnings:[],version:'auth-events',missingRequirements:[]};
test('authenticated WS outlives access expiry; committed revocations notify before blocking future traffic',async()=>{
 const root=await mkdtemp(join(tmpdir(),'auth-events-')),db=await DatabaseStore.open({path:join(root,'auth.sqlite')});let now=10000;
 const auth=await ApiKeyAuthorization.open(db,{issuer:'http://printer.test',now:()=>now}),peers:Peer[]=[];let server:ConfiguredMoonraker|undefined;
 try{
  const config=join(root,'moonraker.conf');await writeFile(config,'[server]\nhost: 127.0.0.1\nport: 0\n');server=await ConfiguredMoonraker.load(config,{information,...auth.networkOptions});auth.register(server.endpoints,server);const address=await server.start(),url=`http://127.0.0.1:${address.port}`;
  const peer=async()=>{const p=new Peer(url.replace('http:','ws:')+'/websocket');peers.push(p);await once(p.socket,'open');return p;};
  const http=async(path:string,body?:object,token?:string,key?:string)=>{const r=await fetch(url+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{}),...(key?{'x-api-key':key}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json() as any};};
  const watch=await peer(),anon=await peer();assert((await watch.call('server.connection.identify',{client_name:'watch',version:'1',type:'web',url:'https://example.test',api_key:auth.localApiKey()})).result);
  const a=(await http('/access/user',{username:'alice',password:'pass'},undefined,auth.localApiKey())).body.result;
  assert.equal((await watch.event('notify_user_created','alice')).params.length,1);
  const b=(await http('/access/user',{username:'bob',password:'pass'},undefined,auth.localApiKey())).body.result;await watch.event('notify_user_created','bob');
  const alice=await peer(),bob=await peer();assert((await alice.call('access.login',{username:'alice',password:'pass'})).result);assert((await bob.call('access.login',{username:'bob',password:'pass'})).result);
  now+=3601;
  assert.equal((await http('/access/user',undefined,a.token)).status,401);
  assert.equal((await alice.call('access.get_user')).result.username,'alice');
  const status=await server.broadcast('notify_status_update',[{test:1}]);assert.equal(status.sent,3);assert.equal(status.denied,1);await alice.wait(value=>value.method==='notify_status_update');
  const expired=await peer();assert((await expired.call('server.connection.identify',{client_name:'expired',version:'1',type:'web',url:'https://example.test',access_token:a.token})).error);assert((await expired.call('access.get_user')).error);
  const refreshed=(await alice.call('access.refresh_jwt',{refresh_token:a.refresh_token})).result;assert.equal((await http('/access/user',undefined,refreshed.token)).status,200);
  const logout=await alice.call('access.logout');assert.equal(logout.result.action,'user_logged_out');
  const notice=await alice.event('notify_user_logged_out','alice');await watch.event('notify_user_logged_out','alice');
  assert(alice.messages.indexOf(logout)<alice.messages.indexOf(notice),'response must precede terminal event');assert((await alice.call('access.get_user')).error);
  assert.equal((await http('/access/refresh_jwt',{refresh_token:a.refresh_token})).status,401);
  const after=await server.broadcast('notify_status_update',[{test:2}]);assert.equal(after.sent,2);assert.equal(after.denied,3);
  const spoof=await server.broadcast('notify_user_logged_out',[{username:'alice'}]);assert.equal(spoof.sent,2);assert.equal(spoof.denied,3,'grant must end with the committed event delivery');
  assert((await alice.call('access.login',{username:'alice',password:'pass'})).result);
  const deletion=await alice.call('access.delete_user',{username:'bob'});assert.equal(deletion.result.action,'user_deleted');await bob.event('notify_user_deleted','bob');await watch.event('notify_user_deleted','bob');assert((await bob.call('access.get_user')).error);
  assert.equal((await http('/access/refresh_jwt',{refresh_token:b.refresh_token})).status,401);
  assert((await alice.call('server.connection.identify',{access_token:'invalid'})).error);assert((await alice.call('access.get_user')).error,'failed reauthentication must not retain the old identity');
  assert((await anon.call('access.get_user')).error);assert.equal(anon.messages.filter(x=>x.method).length,0);
  assert.equal(auth.eventStatus.published,4);assert.equal(auth.eventStatus.pending,0);assert.equal(auth.eventStatus.failed,0);
 }finally{for(const p of peers)p.socket.terminate();await server?.close();await auth.close();await db.close();await rm(root,{recursive:true,force:true});}
});
test('failed user writes emit no authorization event and invalid requests release event capacity',async()=>{
 const root=await mkdtemp(join(tmpdir(),'auth-event-failure-')),db=await DatabaseStore.open({path:join(root,'auth.sqlite')}),auth=await ApiKeyAuthorization.open(db,{issuer:'http://printer.test'});let server:ConfiguredMoonraker|undefined;const insert=db.insert;
 try{
  const config=join(root,'moonraker.conf');await writeFile(config,'[server]\nhost: 127.0.0.1\nport: 0\n');server=await ConfiguredMoonraker.load(config,{information,...auth.networkOptions});auth.register(server.endpoints,server);const address=await server.start(),url=`http://127.0.0.1:${address.port}/access/user`;
  const create=async(body:object)=>{const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-api-key':auth.localApiKey()},body:JSON.stringify(body)});await r.arrayBuffer();return r.status;};
  for(let i=0;i<130;i++)assert.equal(await create({}),400);assert.equal(auth.eventStatus.pending,0);
  db.insert=async()=>{throw Error('injected disk failure');};assert.equal(await create({username:'alice',password:'pass'}),500);assert.equal(auth.eventStatus.published,0);assert.equal(auth.eventStatus.pending,0);
 }finally{db.insert=insert;await server?.close();await auth.close();await db.close();await rm(root,{recursive:true,force:true});}
});
test('disconnect during durable mutation still publishes its committed event exactly once',async()=>{
 const {JsonRpcDispatcher}=await import('../src/moonraker/rpc.ts'),{EndpointRegistry}=await import('../src/moonraker/endpoints.ts'),{ResponseCompletion}=await import('../src/moonraker/response-completion.ts');
 const root=await mkdtemp(join(tmpdir(),'auth-event-cancel-')),db=await DatabaseStore.open({path:join(root,'auth.sqlite')}),auth=await ApiKeyAuthorization.open(db,{issuer:'http://printer.test'}),insert=db.insert;
 const rpc=new JsonRpcDispatcher(),endpoints=new EndpointRegistry(rpc),abort=new AbortController(),completion=new ResponseCompletion(abort.signal),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),events:string[]=[];
 try{
  auth.register(endpoints,{broadcast:async method=>{events.push(method);return {sent:1,denied:0,closed:0,overflow:0,failed:0};}});
  db.insert=async(...args)=>{if(args[0]==='native_users'){entered.resolve();await release.promise;}return insert.apply(db,args);};
  const work=rpc.dispatchValue({jsonrpc:'2.0',id:1,method:'access.post_user',params:{username:'alice',password:'pass'}},{transport:'http',signal:abort.signal,authorize:()=>({username:'_API_KEY_USER_'}),afterResponse:callback=>completion.add(callback)});
  await entered.promise;abort.abort(Error('client disconnected'));assert.deepEqual(events,[]);release.resolve();await work;
  assert.deepEqual(events,['notify_user_created']);assert.equal(auth.eventStatus.pending,0);assert.equal((await db.get('native_users','users') as any[])[0].username,'alice');completion.complete(false);assert.equal(events.length,1);
 }finally{release.resolve();db.insert=insert;await auth.close();await db.close();await rm(root,{recursive:true,force:true});}
});
