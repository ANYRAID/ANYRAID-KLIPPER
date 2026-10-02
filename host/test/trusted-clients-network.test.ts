import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {IncomingMessage} from 'node:http';
import {Socket} from 'node:net';
import {WebSocket} from 'ws';
import {ApiKeyAuthorization} from '../src/moonraker/api-key-authorization.ts';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
const information={connected:false,state:'disconnected' as const,components:[],failedComponents:[],directories:[],warnings:[],version:'trusted-test',missingRequirements:[]};
for(const forceLogins of [false,true])test(`trusted socket policy, credentials precedence and forced-login revocation (${forceLogins})`,async t=>{
 const dir=await mkdtemp(join(tmpdir(),'trusted-policy-')),db=await DatabaseStore.open({path:join(dir,'auth.sqlite')}),auth=await ApiKeyAuthorization.open(db,{issuer:'http://printer.test',trustedClients:['127.0.0.1/32'],forceLogins});let server:ConfiguredMoonraker|undefined,ws:WebSocket|undefined;
 try{
  const path=join(dir,'moonraker.conf');await writeFile(path,'[server]\nhost: 127.0.0.1\nport: 0\n');server=await ConfiguredMoonraker.load(path,{information,...auth.networkOptions});auth.register(server.endpoints);const address=await server.start(),base=`http://127.0.0.1:${address.port}`;
  const http=async(path:string,headers:Record<string,string>={},body?:object)=>fetch(base+path,{headers:{...headers,'content-type':'application/json'},...body?{method:'POST',body:JSON.stringify(body)}:{}});
  assert.equal((await http('/server/info')).status,200);const info=await (await http('/access/info')).json();assert.equal(info.result.trusted,true);assert.equal(info.result.login_required,false);
  for(const headers of [{'x-api-key':'invalid'},{authorization:'Bearer invalid'},{'x-forwarded-for':'127.0.0.1'},{'x-real-ip':'127.0.0.1'},{forwarded:'for=127.0.0.1'}] as Record<string,string>[])assert.equal((await http('/server/info',headers)).status,401);
  assert.equal((await http('/server/info',{origin:'https://untrusted.example'})).status,403);
  const socket=new Socket();Object.defineProperty(socket,'remoteAddress',{value:'192.0.2.1'});const req=new IncomingMessage(socket);req.url='/';req.headers['x-forwarded-for']='127.0.0.1';assert.throws(()=>auth.authorize('server.info',{}, {request:req,transport:'http',signal:new AbortController().signal}),/Unauthorized/);socket.destroy();
  ws=new WebSocket(base.replace('http:','ws:')+'/websocket');await once(ws,'open');const call=async(method:string,params={})=>{const response=once(ws!,'message');ws!.send(JSON.stringify({jsonrpc:'2.0',id:1,method,params}));return JSON.parse(String((await response)[0]));};
  assert((await call('server.connection.identify',{client_name:'mainsail',version:'2.19.0',type:'web',url:'https://github.com/mainsail-crew/mainsail'})).result.connection_id);
  const oneShot=(await (await http('/access/oneshot_token')).json()).result;
  const key=auth.localApiKey(),created=await http('/access/user',{'x-api-key':key},{username:'owner',password:'test-only'});assert.equal(created.status,200);const token=(await created.json()).result.token;
  assert.equal((await http('/server/info?token='+oneShot)).status,forceLogins?401:200);
  assert.equal((await http('/server/info')).status,forceLogins?401:200);assert.equal(!!(await call('server.info')).error,forceLogins);
  assert.equal((await (await http('/access/info')).json()).result.login_required,forceLogins);
  assert.equal((await http('/server/info',{authorization:'Bearer '+token})).status,200);
  assert.equal((await http('/server/info',{'x-api-key':key})).status,200);
  if(!forceLogins){
   const request=new IncomingMessage(new Socket());Object.defineProperty(request.socket,'remoteAddress',{value:'127.0.0.1'});request.url='/server/info';const context={request,transport:'http' as const,signal:new AbortController().signal};
   const samples:number[]=[];for(let batch=0;batch<8;batch++){const begin=performance.now();for(let i=0;i<10000;i++)auth.authorize('server.info',{},context);if(batch)samples.push((performance.now()-begin)*1000/10000);}samples.sort((a,b)=>a-b);t.diagnostic(JSON.stringify({trustedAuthorizeMedianUs:samples[3],calls:80000,scope:'desktop hot-path microbenchmark'}));request.socket.destroy();
  }
 }finally{ws?.terminate();await server?.close();await auth.close();await db.close();await rm(dir,{recursive:true,force:true});}
});
