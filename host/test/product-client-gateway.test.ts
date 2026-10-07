import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {request} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {ApiKeyAuthorization} from '../src/moonraker/api-key-authorization.ts';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
import {ProductClientGateway,type ProductClientGatewayOptions} from '../src/runtime/product-client-gateway.ts';
const origin='http://127.0.0.1:18420';
const info={connected:false,state:'disconnected' as const,components:[],failedComponents:[],directories:[],warnings:[],version:'gateway-test',missingRequirements:[]};
async function fixture(run:(f:Awaited<ReturnType<typeof setup>>)=>Promise<void>,options:Partial<ProductClientGatewayOptions>={},clock?:()=>number){
 const f=await setup(options,clock);try{await run(f);}finally{for(const ws of f.sockets)ws.terminate();await f.gateway.close();await f.server.close();await f.auth.close();await f.db.close();await rm(f.root,{recursive:true,force:true});}
}
async function setup(options:Partial<ProductClientGatewayOptions>,clock?:()=>number){
 const root=await mkdtemp(join(tmpdir(),'product-client-gateway-')),db=await DatabaseStore.open({path:join(root,'auth.sqlite')}),auth=await ApiKeyAuthorization.open(db,{issuer:'http://printer.test',forceLogins:true,...clock?{now:clock}:{}}),config=join(root,'moonraker.conf');
 let server:ConfiguredMoonraker|undefined,gateway:ProductClientGateway|undefined;
 try{
  await writeFile(config,'[server]\nhost: 127.0.0.1\nport: 0\n');server=await ConfiguredMoonraker.load(config,{information:info,...auth.networkOptions});auth.register(server.endpoints);
  let writes=0;server.endpoints.register({endpoint:'/server/echo',methods:['POST'],transports:['http']},p=>{writes++;return {payload:p.payload,writes};});
  const address=await server.start(),upstream=`http://127.0.0.1:${address.port}`;
  const native=async(path:string,method='GET',body?:object,token?:string,key?:string)=>{const r=await fetch(upstream+path,{method,headers:{'content-type':'application/json',...token?{authorization:'Bearer '+token}:{},...key?{'x-api-key':key}:{}},body:body?JSON.stringify(body):undefined});return {code:r.status,body:await r.json() as any};};
  const alice=(await native('/access/user','POST',{username:'alice',password:'local-fixture-only'},undefined,auth.localApiKey())).body.result;
  const bob=(await native('/access/user','POST',{username:'bob',password:'local-fixture-only'},alice.token)).body.result;
  gateway=new ProductClientGateway({origin,upstream,loopbackHttp:true,client:async(_q,r)=>{r.end('fixed client');},...options});const exposed=await gateway.listen(0),url=`http://127.0.0.1:${exposed.port}`,sockets:WebSocket[]=[];
  const http=async(path:string,method='GET',body?:unknown,cookie?:string,extra:Record<string,string>={})=>new Promise<{code:number;body:any;cookie:string|undefined;raw:string}>((resolve,reject)=>{
   const rawBody=body===undefined?undefined:JSON.stringify(body),req=request(url+path,{method,headers:{host:new URL(origin).host,origin,'content-type':'application/json',...cookie?{cookie}:{},...extra}},res=>{let text='';res.setEncoding('utf8');res.on('data',s=>text+=s);res.once('end',()=>{let parsed;try{parsed=JSON.parse(text);}catch{parsed=text;}resolve({code:res.statusCode!,body:parsed,cookie:res.headers['set-cookie']?.[0],raw:text});});res.once('error',reject);});req.once('error',reject);req.end(rawBody);
  });
  const login=async(name='alice')=>{const r=await http('/_client/session','POST',{username:name,password:'local-fixture-only'});assert.equal(r.code,200);assert.deepEqual(r.body,{result:{username:name}});assert(r.cookie);assert.match(r.cookie,/HttpOnly; SameSite=Strict/);assert(!r.cookie.includes(alice.token)&&!r.cookie.includes(bob.token));return r.cookie.split(';')[0];};
  const websocket=async(cookie:string,extra:Record<string,string>={})=>{const ws=new WebSocket(url.replace('http:','ws:')+'/websocket',{headers:{host:new URL(origin).host,origin,cookie,...extra}});sockets.push(ws);await once(ws,'open');return ws;};
  const rpc=async(ws:WebSocket,method:string,params={})=>{const response=once(ws,'message');ws.send(JSON.stringify({jsonrpc:'2.0',id:1,method,params}));return JSON.parse(String((await response)[0]));};
  return {root,db,auth,server,gateway,native,http,login,websocket,rpc,sockets,alice,bob,writes:()=>writes,url};
 }catch(e){await gateway?.close();await server?.close();await auth.close();await db.close();await rm(root,{recursive:true,force:true});throw e;}
}
test('gateway accepts only an explicit origin and fixed private native listener',()=>{
 const good={origin,upstream:'http://127.0.0.1:7125',loopbackHttp:true};
 for(const option of [{loopbackHttp:false},{origin:'http://printer.example.com'},{upstream:'http://example.com'},{upstream:'http://127.0.0.1:7125/server'},{upstream:'http://operator:secret@127.0.0.1:7125'},{maxSessions:0}])assert.throws(()=>new ProductClientGateway({...good,...option}),/Invalid/);
 const unopened=new ProductClientGateway(good);assert.equal(unopened.status.sessions,0);return unopened.close();
});
test('unchanged client HTTP and websocket use native per-user identity; cookie never exposes JWT or grants anonymous access',()=>fixture(async f=>{
 assert.equal((await f.native('/server/info')).code,401);assert.equal((await f.http('/server/info')).code,401);assert.equal((await f.http('/')).code,401);
 assert.equal((await f.http('/_client/session','POST',{username:'alice',password:'wrong'})).code,401);for(const path of ['/', '/_client/control'])assert.equal((await f.http(path,'GET',undefined,undefined,{accept:'text/html'})).code,303);
 const a=await f.login(),b=await f.login('bob');assert.equal((await f.http('/')).code,401);assert.equal((await f.http('/','GET',undefined,a)).body,'fixed client');
 assert.equal((await f.http('/access/user','GET',undefined,a,{'x-api-key':f.auth.localApiKey(),'x-access-token':f.bob.token,authorization:'Bearer '+f.bob.token})).body.result.username,'alice');
 assert.equal((await f.http('/access/user','GET',undefined,b)).body.result.username,'bob');assert(!JSON.stringify(f.gateway.status).includes(a));
 const ws=await f.websocket(a);assert((await f.rpc(ws,'server.connection.identify',{client_name:'mainsail',version:'2.19.0',type:'web',url:'https://github.com/mainsail-crew/mainsail'})).result.connection_id);
 assert.equal((await f.rpc(ws,'access.get_user')).result.username,'alice');assert.equal((await f.rpc(ws,'server.info')).result.moonraker_version,'gateway-test');
 const closed=once(ws,'close');assert.equal((await f.http('/_client/session','DELETE',undefined,a)).code,200);await closed;
 assert.equal((await f.http('/server/info','GET',undefined,a)).code,401);assert.equal((await f.native('/access/user','GET',undefined,f.alice.token)).code,401);
 assert.equal((await f.http('/access/user','GET',undefined,b)).body.result.username,'bob');assert.equal((await f.native('/access/user','GET',undefined,f.bob.token)).code,200);
}));
test('foreign origins, spoofed hosts and duplicated session cookies reject before native effects',()=>fixture(async f=>{
 const a=await f.login();for(const extra of [{origin:'https://foreign.example'},{host:'foreign.example'},{cookie:a+'; '+a}] as Record<string,string>[])assert.notEqual((await f.http('/server/echo','POST',{payload:'must not run'},a,extra)).code,200);
 assert.equal(f.writes(),0);
 assert.equal((await f.http('/_client/session','POST',{username:'alice',password:'local-fixture-only'},undefined,{origin:'https://foreign.example'})).code,403);
 const ws=new WebSocket(f.url.replace('http:','ws:')+'/websocket',{headers:{host:new URL(origin).host,origin:'https://foreign.example',cookie:a}});f.sockets.push(ws);
 const rejected=once(ws,'unexpected-response');ws.on('error',()=>{});const [,response]=await rejected;assert.equal(response.statusCode,403);response.resume();ws.terminate();assert.equal(f.gateway.status.websockets,0);
 assert.equal((await f.http('/server/info','GET',undefined,a+'A')).code,401);
}));
test('native revocation and gateway restart cannot preserve or transfer a browser identity',()=>fixture(async f=>{
 const a=await f.login(),b=await f.login('bob');assert.equal((await f.native('/access/logout','POST',{},f.alice.token)).code,200);
 assert.equal((await f.http('/_client/session','GET',undefined,a)).code,401);assert.equal((await f.http('/server/info','GET',undefined,a)).code,401);assert.equal((await f.http('/','GET',undefined,a)).code,401);
 assert.equal((await f.http('/server/info','GET',undefined,b)).code,200);const ws=await f.websocket(b),closed=once(ws,'close');await f.gateway.close();await closed;
 assert.deepEqual({...f.gateway.status,listening:false,closed:true},{listening:false,closed:true,sessions:0,requests:0,upgrades:0,websockets:0,bufferedBytes:0});
 assert.equal((await f.native('/access/user','GET',undefined,f.bob.token)).code,200);await assert.rejects(f.gateway.listen(0),/Invalid/);
}));
test('native refresh precedes admission; original mutation is forwarded exactly once with large payload intact',async()=>{
 let now=Math.floor(Date.now()/1000)-3570;
 await fixture(async f=>{const a=await f.login();now=Math.floor(Date.now()/1000);const payload='unicode百分号% '.repeat(10000),result=await f.http('/server/echo','POST',{payload},a);assert.equal(result.code,200);assert.equal(result.body.result.payload,payload);assert.equal(result.body.result.writes,1);assert.equal(f.writes(),1);assert.equal((await f.http('/_client/session','GET',undefined,a)).body.result.username,'alice');}, {},()=>now);
});
test('session capacity, malformed login and native outages fail closed without creating additional sessions',()=>fixture(async f=>{
 assert.equal((await f.http('/_client/session','POST',{username:'alice',password:'local-fixture-only',api_key:'ignored'})).code,400);
 const a=await f.login();assert.equal((await f.http('/_client/session','POST',{username:'bob',password:'local-fixture-only'})).code,429);assert.equal(f.gateway.status.sessions,1);
 const replacement=await f.http('/_client/session','POST',{username:'bob',password:'local-fixture-only'},a);assert.equal(replacement.code,200);assert.equal(f.gateway.status.sessions,1);assert.equal((await f.http('/server/info','GET',undefined,a)).code,401);assert(replacement.cookie);const b=replacement.cookie.split(';')[0];
 assert.equal((await f.http('/_client/session','DELETE',undefined,b)).code,200);assert.equal(f.gateway.status.sessions,0);
 await f.server.close();assert.equal((await f.http('/_client/session','POST',{username:'bob',password:'local-fixture-only'})).code,502);assert.equal(f.gateway.status.sessions,0);
}, {maxSessions:1}));
test('gateway close during listener startup joins startup and leaves no live listener',async()=>{
 const gateway=new ProductClientGateway({origin,upstream:'http://127.0.0.1:7125',loopbackHttp:true});const listening=gateway.listen(0),closing=gateway.close();await assert.rejects(listening,/cancelled/);await closing;assert.equal(gateway.status.closed,true);assert.equal(gateway.status.listening,false);await delay(0);
});
