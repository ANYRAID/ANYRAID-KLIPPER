import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';import {DatabaseStore} from '../src/moonraker/database.ts';
import {ApiKeyAuthorization} from '../src/moonraker/api-key-authorization.ts';import {CorsPolicy} from '../src/moonraker/cors-policy.ts';import {MoonrakerNetwork,type MoonrakerNetworkOptions} from '../src/moonraker/server.ts';import {EndpointRegistry} from '../src/moonraker/endpoints.ts';import {JsonRpcDispatcher} from '../src/moonraker/rpc.ts';import {WebSocket} from 'ws';import {once} from 'node:events';import {setTimeout as delay} from 'node:timers/promises';
const information={connected:false,state:'disconnected' as const,components:[],failedComponents:[],directories:[],warnings:[],version:'cors-domain-owner',missingRequirements:[]};
test('configured numeric Origin fallback uses the original trusted hostname owner before authentication',async()=>{
 const root=await mkdtemp(join(tmpdir(),'cors-domain-owner-')),db=await DatabaseStore.open({path:join(root,'db.sqlite')}),config=join(root,'moonraker.conf');let server:ConfiguredMoonraker|undefined;
 try{
  await writeFile(config,'[server]\nhost: 127.0.0.1\nport: 0\n[authorization]\ntrusted_clients: localhost\ncors_domains: https://unrelated.example\n');
  server=await ConfiguredMoonraker.loadAuthorized(config,{database:db,information,authorization:{issuer:'http://printer.example'}});const address=await server.start(),base='http://127.0.0.1:'+address.port,origin='http://127.0.0.1:18430';
  const preflight=await fetch(base+'/server/info',{method:'OPTIONS',headers:{origin,'access-control-request-method':'GET'}});assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),origin);await preflight.arrayBuffer();
  const trusted=await fetch(base+'/server/info',{headers:{origin}});assert.equal(trusted.status,200);assert.equal(trusted.headers.get('access-control-allow-origin'),origin);await trusted.arrayBuffer();
  const denied=await fetch(base+'/server/info',{headers:{origin,'x-api-key':'invalid'}});assert.equal(denied.status,401);assert.equal(denied.headers.get('access-control-allow-origin'),origin);await denied.arrayBuffer();
 }finally{await server?.close();await db.close();await rm(root,{recursive:true,force:true});}
});

test('numeric fallback and RPC trust borrow one cache while force login remains independent',async()=>{
 const root=await mkdtemp(join(tmpdir(),'cors-shared-owner-')),db=await DatabaseStore.open({path:join(root,'db.sqlite')}),config=join(root,'moonraker.conf');let lookups=0;await writeFile(config,'[server]\nhost: 127.0.0.1\nport: 0\n');
 const auth=await ApiKeyAuthorization.open(db,{issuer:'http://printer.example',forceLogins:true,trustedClients:['printer.example'],trustedClientOptions:{lookup:{async lookup(){lookups++;return 'printer.example';},async close(){}}}}),cors=new CorsPolicy(['https://unrelated.example'],['printer.example'],()=>{},(address,signal)=>auth.resolveTrustedAddress(address,signal)),server=await ConfiguredMoonraker.load(config,{information,cors,...auth.networkOptions});auth.register(server.endpoints);let ws:WebSocket|undefined;
 try{
  const address=await server.start(),base='http://127.0.0.1:'+address.port,origin='http://127.0.0.1:18430';const first=await fetch(base+'/server/info',{headers:{origin}});assert.equal(first.status,200);await first.arrayBuffer();assert.equal(lookups,1);
  ws=new WebSocket(base.replace('http','ws')+'/websocket',{origin});await once(ws,'open');const call=async()=>{const reply=once(ws!,'message');ws!.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'server.info'}));return JSON.parse(String((await reply)[0]));};assert.ok((await call()).result);assert.equal(lookups,1);
  const created=await fetch(base+'/access/user',{method:'POST',headers:{'content-type':'application/json','x-api-key':auth.localApiKey()},body:JSON.stringify({username:'owner',password:'fixture-only'})});assert.equal(created.status,200);await created.arrayBuffer();
  const forced=await fetch(base+'/server/info',{headers:{origin}});assert.equal(forced.status,401);assert.equal(forced.headers.get('access-control-allow-origin'),origin);await forced.arrayBuffer();assert.ok((await call()).error);
  const key=await fetch(base+'/server/info',{headers:{origin,'x-api-key':auth.localApiKey()}});assert.equal(key.status,200);await key.arrayBuffer();assert.equal(lookups,1);
  const bad=await fetch(base+'/server/info',{headers:{origin,authorization:'Bearer invalid'}});assert.equal(bad.status,401);assert.equal(bad.headers.get('access-control-allow-origin'),origin);await bad.arrayBuffer();
 }finally{ws?.terminate();await server.close();await auth.close();await db.close();await rm(root,{recursive:true,force:true});}
});

test('borrowed resolver sees only canonical numeric Origins after a nonempty unmatched policy',async()=>{
 let calls=0;const resolve=async(address:string)=>{calls++;assert.equal(address,'192.0.2.8');return true;},signal=new AbortController().signal,policy=new CorsPolicy(['https://front.example'],[],()=>{},resolve);
 assert.equal(policy.check('https://front.example',signal),true);for(const origin of ['https://printer.example','null','file:///tmp/a','http://127.0.0.1:80','http://[::1]','http://user:pass@192.0.2.8','http://192.0.2.8/path','http://192.0.2.8/','http://192.0.2.8?query','http://192.0.2.8#hash','x'.repeat(1025)])assert.equal(policy.check(origin,signal),false,origin);
 assert.equal(new CorsPolicy([],[],()=>{},resolve).check('http://192.0.2.8',signal),false);assert.equal(calls,0);assert.equal(await policy.check('http://192.0.2.8:7125',signal),true);assert.equal(calls,1);assert.throws(()=>new CorsPolicy(['*'],[],()=>{},123 as any),TypeError);
 const cancelled=new AbortController();cancelled.abort(new Error('retired'));assert.throws(()=>policy.check('http://192.0.2.8',cancelled.signal),/retired/);
});

async function network(resolver:(address:string,signal:AbortSignal)=>boolean|Promise<boolean>,limits:Partial<MoonrakerNetworkOptions>={}){
 const rpc=new JsonRpcDispatcher(),endpoints=new EndpointRegistry(rpc);let invoked=0,authorized=0;endpoints.register({endpoint:'/server/test',methods:['GET']},()=>{invoked++;return true;});
 const service=new MoonrakerNetwork(rpc,{endpoints,cors:new CorsPolicy(['https://front.example'],[],()=>{},resolver),authorize(){authorized++;},...limits}),address=await service.listen();return {service,base:'http://127.0.0.1:'+address.port,get invoked(){return invoked;},get authorized(){return authorized;}};
}
const origin='http://192.0.2.8:7125';
async function until(check:()=>boolean){for(let i=0;i<200;i++){if(check())return;await delay(5);}throw Error('condition timed out');}
function blocked(){const entered=Promise.withResolvers<void>();let signal:AbortSignal|undefined;const resolver=(_address:string,s:AbortSignal)=>{signal=s;entered.resolve();return new Promise<boolean>((resolve,reject)=>{s.addEventListener('abort',()=>reject(s.reason),{once:true});});};return {entered,resolver,get signal(){return signal;}};}

test('HTTP origin query is counted and closed without invoking an endpoint',async()=>{
 const wait=blocked(),f=await network(wait.resolver);try{const pending=fetch(f.base+'/server/test',{headers:{origin}}).catch(e=>e);await wait.entered.promise;assert.equal(f.service.status.requests,1);await f.service.close();assert.equal(wait.signal?.aborted,true);await pending;assert.equal(f.invoked,0);assert.equal(f.authorized,0);assert.equal(f.service.status.requests,0);}finally{await f.service.close();}
});
test('client HTTP disconnect cancels only its Origin request and releases capacity',async()=>{
 const wait=blocked(),f=await network(wait.resolver),abort=new AbortController();try{const pending=fetch(f.base+'/server/test',{headers:{origin},signal:abort.signal}).catch(e=>e);await wait.entered.promise;abort.abort();await pending;await until(()=>wait.signal?.aborted===true&&f.service.status.requests===0);assert.equal(f.invoked,0);assert.equal(f.authorized,0);}finally{await f.service.close();}
});
test('original request deadline bounds HTTP and upgrade origin queries',async()=>{
 for(const upgrade of[false,true]){const wait=blocked(),f=await network(wait.resolver,{requestTimeoutMs:100});let ws:WebSocket|undefined;try{const pending=upgrade?(ws=new WebSocket(f.base.replace('http','ws')+'/websocket',{origin}),once(ws,'open').catch(e=>e)):fetch(f.base+'/server/test',{headers:{origin}}).catch(e=>e);await wait.entered.promise;assert.equal(wait.signal?.aborted,false);await pending;await until(()=>wait.signal?.aborted===true&&f.service.status.requests===0);assert.equal(f.invoked,0);assert.equal(f.authorized,0);assert.equal(f.service.status.connections,0);}finally{ws?.terminate();await f.service.close();}}
});
test('pending upgrades reserve original connection capacity and close without an accepted peer',async()=>{
 const wait=blocked(),f=await network(wait.resolver,{maxConnections:1});let ws:WebSocket|undefined,extra:WebSocket|undefined;try{ws=new WebSocket(f.base.replace('http','ws')+'/websocket',{origin});const pending=once(ws,'open').catch(e=>e);await wait.entered.promise;assert.equal(f.service.status.connections,0);assert.equal(f.service.status.requests,1);extra=new WebSocket(f.base.replace('http','ws')+'/websocket');await assert.rejects(once(extra,'open'),/503/);await f.service.close();await pending;assert.equal(wait.signal?.aborted,true);assert.equal(f.service.status.requests,0);assert.equal(f.service.status.connections,0);}finally{extra?.terminate();ws?.terminate();await f.service.close();}
});
test('client upgrade disconnect cancels Origin lookup without leaving a peer',async()=>{
 const wait=blocked(),f=await network(wait.resolver);let ws:WebSocket|undefined;try{ws=new WebSocket(f.base.replace('http','ws')+'/websocket',{origin});const pending=once(ws,'open').catch(e=>e);await wait.entered.promise;ws.terminate();await pending;await until(()=>wait.signal?.aborted===true&&f.service.status.requests===0);assert.equal(f.service.status.connections,0);assert.equal(f.authorized,0);}finally{ws?.terminate();await f.service.close();}
});
test('pending Origin work consumes original HTTP request capacity',async()=>{
 const wait=blocked(),f=await network(wait.resolver,{maxRequests:1});try{const pending=fetch(f.base+'/server/test',{headers:{origin}}).catch(e=>e);await wait.entered.promise;const extra=await fetch(f.base+'/server/test');assert.equal(extra.status,429);await extra.arrayBuffer();assert.equal(f.service.status.requests,1);await f.service.close();await pending;assert.equal(f.invoked,0);}finally{await f.service.close();}
});
test('late resolver permit after request cancellation cannot open a websocket or invoke a method',async()=>{
 const entered=Promise.withResolvers<void>(),reply=Promise.withResolvers<boolean>(),abort=new AbortController(),policy=new CorsPolicy(['https://front.example'],[],()=>{},(_address,signal)=>{assert.equal(signal,abort.signal);entered.resolve();return reply.promise;});const pending=Promise.resolve(policy.check(origin,abort.signal)).catch(e=>e);await entered.promise;abort.abort(new Error('retired'));reply.resolve(true);assert.match((await pending).message,/retired/);
});
