import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
import {DatabaseStore} from '../src/moonraker/database.ts';
const information={connected:false,state:'disconnected' as const,components:[],failedComponents:[],directories:[],warnings:[],version:'cors',missingRequirements:[]};
const origin='https://fluidd.example.com';
async function fixture(run:(server:ConfiguredMoonraker,url:string)=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'configured-cors-')),db=await DatabaseStore.open({path:join(root,'db')}),config=join(root,'moonraker.conf');let server:ConfiguredMoonraker|undefined;
 try{
  await writeFile(config,'[server]\nhost: 127.0.0.1\nport: 0\n[authorization]\nforce_logins: true\ncors_domains:\n https://*.example.com\n https://discard.*\n');
  server=await ConfiguredMoonraker.loadAuthorized(config,{information,database:db,authorization:{issuer:'http://printer.test'}});const address=await server.start();await run(server,'http://127.0.0.1:'+address.port);
 }finally{await server?.close();await db.close();await rm(root,{recursive:true,force:true});}
}
test('configured CORS permits preflight, API-key/login/JWT and readable errors without bypassing authorization',()=>fixture(async(server,url)=>{
 let invoked=0;server.endpoints.register({endpoint:'/server/cors_test',methods:['POST']},()=>{invoked++;return true;});
 const preflight=await fetch(url+'/server/cors_test',{method:'OPTIONS',headers:{origin,'access-control-request-method':'POST','access-control-request-headers':'Authorization, X-Access-Token, Content-Type'}});
 assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),origin);assert.equal(preflight.headers.get('access-control-allow-credentials'),'true');assert.match(preflight.headers.get('access-control-allow-headers')!,/X-Access-Token/);assert.equal(invoked,0);
 const denied=await fetch(url+'/server/cors_test',{method:'POST',headers:{origin}});assert.equal(denied.status,401);assert.equal(denied.headers.get('access-control-allow-origin'),origin);await denied.arrayBuffer();assert.equal(invoked,0);
 const blocked=await fetch(url+'/server/cors_test',{method:'POST',headers:{origin:'https://evil.invalid','x-api-key':server.authorization!.localApiKey()}});assert.equal(blocked.status,403);assert.equal(blocked.headers.get('access-control-allow-origin'),null);await blocked.arrayBuffer();assert.equal(invoked,0);
 const headers={origin,'content-type':'application/json','x-api-key':server.authorization!.localApiKey()};
 const created=await fetch(url+'/access/user',{method:'POST',headers,body:JSON.stringify({username:'alice',password:'test-password'})});assert.equal(created.status,200);await created.arrayBuffer();
 const login=await fetch(url+'/access/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({username:'alice',password:'test-password'})});assert.equal(login.status,200);assert.equal(login.headers.get('access-control-allow-origin'),origin);const token=((await login.json()) as any).result.token;
 const good=await fetch(url+'/server/cors_test',{method:'POST',headers:{origin,'x-access-token':token}});assert.equal(good.status,200);await good.arrayBuffer();assert.equal(invoked,1);
 const logout=await fetch(url+'/access/logout',{method:'POST',headers:{origin,authorization:'Bearer '+token}});assert.equal(logout.status,200);await logout.arrayBuffer();
 const revoked=await fetch(url+'/server/cors_test',{method:'POST',headers:{origin,'x-access-token':token}});assert.equal(revoked.status,401);await revoked.arrayBuffer();assert.equal(invoked,1);assert.ok(server.reader.warnings().some(v=>v.includes('top level domain')));
}));
test('configured CORS websocket still requires identity and rejects disallowed browser upgrades',()=>fixture(async(server,url)=>{
 let ws:WebSocket|undefined;
 try{
  const bad=new WebSocket(url.replace('http','ws')+'/websocket',{origin:'https://evil.invalid'});await assert.rejects(once(bad,'open'),/403/);bad.terminate();
  ws=new WebSocket(url.replace('http','ws')+'/websocket',{origin});await once(ws,'open');
  const call=async(method:string,params:any={})=>{const next=once(ws!,'message');ws!.send(JSON.stringify({jsonrpc:'2.0',id:1,method,params}));return JSON.parse(String((await next)[0]));};
  assert.ok((await call('server.info')).error);
  assert.ok((await call('server.connection.identify',{client_name:'cors-test',version:'1',type:'web',url:origin,api_key:server.authorization!.localApiKey()})).result);
  assert.ok((await call('server.info')).result);
 }finally{ws?.terminate();}
}));
