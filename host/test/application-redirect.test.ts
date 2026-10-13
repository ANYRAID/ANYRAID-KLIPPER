import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {setTimeout as delay} from 'node:timers/promises';
import {redirectArgument,safeRedirectTarget} from '../src/moonraker/redirect-target.ts';
import {CorsPolicy} from '../src/moonraker/cors-policy.ts';
import {ApiKeyAuthorization,type AuthorizationOptions} from '../src/moonraker/api-key-authorization.ts';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {ConfiguredMoonraker,type ConfiguredAuthorizationOptions} from '../src/moonraker/configured-server.ts';
import {MoonrakerNetwork,type MoonrakerNetworkOptions} from '../src/moonraker/server.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher} from '../src/moonraker/rpc.ts';
import {mqttCertificate} from './helpers/mqtt-certificate.ts';
const information={connected:false,state:'disconnected' as const,components:[],failedComponents:[],directories:[],warnings:[],version:'redirect-owner',missingRequirements:[]};
const target='https://front.example',route='/scope/server/redirect',signal=new AbortController().signal;
const bytes=(value:unknown)=>Buffer.from(JSON.stringify(value));
const query=(url:string)=>'?url='+encodeURIComponent(url);
async function until(check:()=>boolean){for(let i=0;i<100&&!check();i++)await delay(10);assert.ok(check());}
function raw(url:string,body=Buffer.alloc(0),ca?:string){return new Promise<{status:number;headers:import('node:http').IncomingHttpHeaders;body:string}>((resolve,reject)=>{
 const call=ca?httpsRequest:httpRequest,request=call(url,{method:'GET',headers:{'content-type':'text/plain','content-length':body.length},...(ca?{ca}:{})},response=>{const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode!,headers:response.headers,body:Buffer.concat(chunks).toString()}));});request.on('error',reject);request.end(body);
});}
async function fixture(cors=target,extra:Partial<ConfiguredAuthorizationOptions>={},trusted='',tls=false){
 const root=await mkdtemp(join(tmpdir(),'redirect-owner-')),db=await DatabaseStore.open({path:join(root,'db.sqlite')}),config=join(root,'moonraker.conf');let server:ConfiguredMoonraker|undefined;
 try{const identity=tls?await mqttCertificate():undefined;if(identity){await writeFile(join(root,'cert.pem'),identity.cert);await writeFile(join(root,'key.pem'),identity.key,{mode:0o600});}
  await writeFile(config,'[server]\nhost: 127.0.0.1\nport: 0\nroute_prefix: /scope\n'+(identity?'ssl_port: 0\nssl_certificate_path: '+join(root,'cert.pem')+'\nssl_key_path: '+join(root,'key.pem')+'\n':'')+'[authorization]\n'+(cors?'cors_domains: '+cors+'\n':'')+(trusted?'trusted_clients: '+trusted+'\n':''));
  server=await ConfiguredMoonraker.loadAuthorized(config,{database:db,information,authorization:{issuer:'http://printer.example'},...extra});const address=await server.start();
  return {server,base:'http://127.0.0.1:'+address.port,secure:address.secure?'https://127.0.0.1:'+address.secure.port:undefined,identity,async close(){await server!.close();await db.close();await rm(root,{recursive:true,force:true});}};
 }catch(error){await server?.close();await db.close();await rm(root,{recursive:true,force:true});throw error;}
}
async function expect(base:string,path:string,status:number,options:RequestInit={}){const response=await fetch(base+path,{...options,redirect:'manual'});assert.equal(response.status,status,path);const text=await response.text();if(status!==302)assert.equal(response.headers.get('location'),null);return {response,text};}

test('redirect selects the last Python-stripped query value before a JSON GET body',()=>{
 const body=bytes({url:target+'/body'});
 assert.equal(redirectArgument('url=ignored&url='+encodeURIComponent('\x1c\u2000'+target+'\u3000'),body),target);
 assert.equal(redirectArgument('',body),target+'/body');assert.equal(redirectArgument('url=',body),'');
 assert.equal(redirectArgument('%75rl='+encodeURIComponent(target)+'/literal%zz',body),target+'/literal%zz');
 assert.throws(()=>redirectArgument('url=%ff',body),/Invalid redirect URL/);
 for(const value of[{},[],{url:null},{url:123},'not-object'])assert.throws(()=>redirectArgument('',bytes(value)),/url/i);
 for(const body of[Buffer.from('{'),Buffer.from([0xff])])assert.throws(()=>redirectArgument('',body),/No url/);
 assert.equal(redirectArgument('url='+encodeURIComponent('\ufeff'+target),body),'\ufeff'+target);
});
test('redirect header preserves safe bytes while rejecting normalization and header ambiguity',()=>{
 for(const value of[target,target+'/',target+'?x=%2f#last',target+'/path//next?x=a%2Bb',target+'/路径?x=文件'])assert.equal(safeRedirectTarget(value),value.replace(/[^\x21-\x7e]/gu,char=>encodeURIComponent(char)));
 for(const value of['/relative','javascript:alert(1)','data:text/plain,x','file:///tmp/private','https://user:secret@front.example',target+'\r\nX-Test: bad',target+'\\evil',target+'/a/../b',target+'/%2e%2e/b','https://FRONT.example','https://front.example:443',target+'/ bad','\ufeff'+target,target+'/'+'a'.repeat(4096),target+'/'+'界'.repeat(500)])assert.equal(safeRedirectTarget(value),undefined,value);
});
test('full target CORS preserves path and Unicode scope without broadening to the origin',async()=>{
 const policy=new CorsPolicy([target,target+'/allowed/[a-z]+',target+'/路径']);
 for(const value of[target,target+'///',target+'/allowed/one',target+'/路径/'])assert.equal(await policy.checkRedirect(value,signal),true,value);
 for(const value of[target+'/other',target+'?x=1',target+'/#hash','https://evil.example',target+'/路径/extra'])assert.equal(await policy.checkRedirect(value,signal),false,value);
 let count=0;const resolve=()=>{count++;return true;},empty=new CorsPolicy([],['192.0.2.1'],()=>{},resolve),numeric=new CorsPolicy([target],[],()=>{},resolve);
 assert.equal(await empty.checkRedirect('http://192.0.2.1/path',signal),false);
 for(const value of['https://printer.example/path','http://[::1]/path'])assert.equal(await numeric.checkRedirect(value,signal),false);
 assert.equal(count,0);assert.equal(await numeric.checkRedirect('http://192.0.2.1/path',signal),true);assert.equal(count,1);
});
test('configured redirect is optional-auth GET and cannot grant RPC or alias routes',async()=>{
 const f=await fixture();try{
  const {response}=await expect(f.base,route+query(target+'///'),302);assert.equal(response.headers.get('location'),target+'///');assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('referrer-policy'),'no-referrer');
  await expect(f.base,'/scope/server/info',401);for(const path of['/server/redirect','/scope-neighbor/server/redirect'])await expect(f.base,path+query(target),404);
  for(const headers of[{'x-api-key':'invalid'}, {authorization:'Bearer invalid'}] as Record<string,string>[])await expect(f.base,route+query(target),401,{headers});
  for(const method of['POST','HEAD','PUT'])await expect(f.base,route+query(target),405,{method});
  await expect(f.base,route,400);await expect(f.base,route+query(target+'/not-allowed'),400);
  const rpc=await expect(f.base,'/scope/server/jsonrpc',200,{method:'POST',headers:{'content-type':'application/json','x-api-key':f.server.authorization!.localApiKey()},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'server.redirect',params:{url:target}})});assert.equal(JSON.parse(rpc.text).error.code,-32601);
 }finally{await f.close();}
});
test('configured redirect selects last query, JSON body without JSON content type, and encoded Unicode Location',async()=>{
 const f=await fixture(target+'\n '+target+'/路径');try{
  assert.equal((await raw(f.base+route,bytes({url:target}))).headers.location,target);
  assert.equal((await raw(f.base+route+'?url=ignored&url='+encodeURIComponent(target),bytes({url:'https://evil.example'}))).headers.location,target);
  const unicode=await raw(f.base+route,bytes({url:target+'/路径'}));assert.equal(unicode.status,302);assert.equal(unicode.headers.location,target+'/%E8%B7%AF%E5%BE%84');
  const bad=await raw(f.base+route,bytes({url:target+'\r\nprivate: sentinel'}));assert.equal(bad.status,400);assert.equal(bad.headers.location,undefined);assert.ok(!bad.body.includes('sentinel'));
 }finally{await f.close();}
});
test('redirect Origin preflight is independent of the permitted target',async()=>{
 const f=await fixture();try{
  await expect(f.base,route,405,{method:'OPTIONS'});
  const allowed=await expect(f.base,route,204,{method:'OPTIONS',headers:{origin:target}});assert.equal(allowed.response.headers.get('access-control-allow-origin'),target);
  await expect(f.base,route+query(target),403,{headers:{origin:'https://evil.example'}});
  await expect(f.base,route+query('https://evil.example'),400,{headers:{origin:target}});
  const response=await expect(f.base,route+query(target),302,{headers:{origin:target}});assert.equal(response.response.headers.get('access-control-allow-origin'),target);
 }finally{await f.close();}
});
test('configured redirect requires its native authorization owner and a nonempty CORS policy',async()=>{
 const f=await fixture('');try{await expect(f.base,route+query(target),400);}finally{await f.close();}
 const root=await mkdtemp(join(tmpdir(),'redirect-without-auth-')),config=join(root,'moonraker.conf');let server:ConfiguredMoonraker|undefined;
 try{await writeFile(config,'[server]\nhost: 127.0.0.1\nport: 0\n');server=await ConfiguredMoonraker.load(config,{information,cors:new CorsPolicy([target]),authorize:()=>{}});const address=await server.start();await expect('http://127.0.0.1:'+address.port,'/server/redirect'+query(target),400);
  await assert.rejects(ConfiguredMoonraker.load(config,Object.assign({information,authorize:()=>{}},{redirect:{authorizationAvailable:()=>true}})),/application owner/);
 }finally{await server?.close();await rm(root,{recursive:true,force:true});}
});
async function authFixture(options:AuthorizationOptions){
 const root=await mkdtemp(join(tmpdir(),'redirect-native-auth-')),db=await DatabaseStore.open({path:join(root,'db.sqlite')}),authorization=await ApiKeyAuthorization.open(db,options),rpc=new JsonRpcDispatcher(),endpoints=new EndpointRegistry(rpc);
 authorization.register(endpoints);endpoints.register({endpoint:'/server/info',methods:['GET']},()=>({state:'disconnected'}));
 const service=new MoonrakerNetwork(rpc,{...authorization.networkOptions,endpoints,routePrefix:'/scope',redirect:{authorizationAvailable:()=>!db.status.closed},cors:new CorsPolicy([target],options.trustedClients,()=>{},(address,signal)=>authorization.resolveTrustedAddress(address,signal))});
 const address=await service.listen(0,'127.0.0.1');return {base:'http://127.0.0.1:'+address.port,server:{authorization},async close(){await service.close();await authorization.close();await db.close();await rm(root,{recursive:true,force:true});}};
}
test('numeric redirect borrows the original authorization NSS cache without making requester trusted',async()=>{
 const calls:string[]=[],f=await authFixture({issuer:'http://printer.example',trustedClients:['redirect.test'],trustedClientOptions:{lookup:{async lookup(address){calls.push(address);return address==='192.0.2.1'?'redirect.test':'untrusted.test';},async close(){}}}});
 try{for(let i=0;i<2;i++)await expect(f.base,route+query('http://192.0.2.1/path'),302);assert.deepEqual(calls,['192.0.2.1']);
  await expect(f.base,route+query('https://redirect.test/path'),400);assert.deepEqual(calls,['192.0.2.1']);
  await expect(f.base,'/scope/server/info',401);assert.deepEqual(calls,['192.0.2.1','127.0.0.1']);
 }finally{await f.close();}
});
test('invalid credentials reject before target NSS and rotated credentials reject after its wait',async()=>{
 const entered=Promise.withResolvers<void>(),reply=Promise.withResolvers<string|null>();let lookups=0;
 const f=await authFixture({issuer:'http://printer.example',trustedClients:['redirect.test'],trustedClientOptions:{lookup:{lookup(address){assert.equal(address,'192.0.2.1');lookups++;entered.resolve();return reply.promise;},async close(){reply.resolve(null);}}}});
 try{await expect(f.base,route+query('http://192.0.2.1/path'),401,{headers:{'x-api-key':'invalid'}});assert.equal(lookups,0);
  const key=f.server.authorization!.localApiKey(),pending=expect(f.base,route+query('http://192.0.2.1/path'),401,{headers:{'x-api-key':key}});await entered.promise;await f.server.authorization!.rotate();reply.resolve('redirect.test');await pending;assert.equal(lookups,1);
 }finally{reply.resolve(null);await f.close();}
});
test('one-shot redirect revalidation consumes the original token once and rejects replay',async()=>{
 const f=await fixture();try{const issued=await expect(f.base,'/scope/access/oneshot_token',200,{headers:{'x-api-key':f.server.authorization!.localApiKey()}}),token=JSON.parse(issued.text).result;
  await expect(f.base,route+query(target)+'&token='+encodeURIComponent(token),302);
  await expect(f.base,'/scope/server/info?token='+encodeURIComponent(token),401);
 }finally{await f.close();}
});
async function waiting(options:Partial<MoonrakerNetworkOptions>={}){
 const entered=Promise.withResolvers<void>(),reply=Promise.withResolvers<boolean>();let lookupSignal:AbortSignal|undefined,authorized=0;
 const service=new MoonrakerNetwork(new JsonRpcDispatcher(),{authorize(){authorized++;},redirect:{authorizationAvailable:()=>true},cors:new CorsPolicy([target],[],()=>{},(_address,signal)=>{lookupSignal=signal;entered.resolve();return reply.promise;}),...options});const address=await service.listen(0,'127.0.0.1');
 return {service,base:'http://127.0.0.1:'+address.port,entered,reply,get signal(){return lookupSignal;},get authorized(){return authorized;},async close(){reply.resolve(true);await service.close();}};
}
for(const mode of['disconnect','deadline','shutdown'] as const)test('redirect target NSS uses original '+mode+' boundary and discards late permit',async()=>{
 const f=await waiting(mode==='deadline'?{requestTimeoutMs:100}:{}),abort=new AbortController();try{const pending=fetch(f.base+'/server/redirect'+query('http://192.0.2.1/path'),{redirect:'manual',signal:abort.signal}).then(async response=>({status:response.status,location:response.headers.get('location'),body:await response.text()})).catch(()=>undefined);
  await f.entered.promise;assert.equal(f.service.status.requests,1);const closed=mode==='shutdown'?f.service.close():undefined;if(mode==='disconnect')abort.abort();await until(()=>f.signal?.aborted===true);f.reply.resolve(true);await closed;const result=await pending;if(result){assert.notEqual(result.status,302);assert.equal(result.location,null);}await until(()=>f.service.status.requests===0);assert.equal(f.authorized,1);
 }finally{await f.close();}
});
test('pending redirect uses original request capacity without authorizing additional work',async()=>{
 const f=await waiting({maxRequests:1});try{const pending=expect(f.base,'/server/redirect'+query('http://192.0.2.1/path'),302);await f.entered.promise;await expect(f.base,'/server/redirect'+query(target),429);assert.equal(f.authorized,1);f.reply.resolve(true);await pending;assert.equal(f.authorized,2);}finally{await f.close();}
});
test('redirect JSON GET body uses original byte capacity',async()=>{
 const service=new MoonrakerNetwork(new JsonRpcDispatcher(),{authorize(){},redirect:{authorizationAvailable:()=>true},cors:new CorsPolicy([target]),maxBufferedBytes:2*1024*1024});
 try{const address=await service.listen(0,'127.0.0.1'),response=await raw('http://127.0.0.1:'+address.port+'/server/redirect',bytes({url:target+'/'+'a'.repeat(1024*1024)}));assert.equal(response.status,413);assert.equal(response.headers.location,undefined);await until(()=>service.status.requests===0);}finally{await service.close();}
});
test('redirect HTTP and certificate-verified HTTPS share prefix, target policy and authorization owner',async()=>{
 const f=await fixture(target,{},'',true);try{assert.ok(f.secure);for(const base of[f.base,f.secure]){const response=await raw(base+route+query(target),Buffer.alloc(0),base===f.secure?f.identity!.cert:undefined);assert.equal(response.status,302);assert.equal(response.headers.location,target);}
  const denied=await raw(f.secure+route+query(target+'/not-allowed'),Buffer.alloc(0),f.identity!.cert);assert.equal(denied.status,400);assert.equal(denied.headers.location,undefined);
 }finally{await f.close();}
});
test('network rejects redirect owner endpoint conflicts before listening',()=>{
 const endpoints=new EndpointRegistry(new JsonRpcDispatcher());endpoints.register({endpoint:'/server/redirect',methods:['GET']},()=>true);
 assert.throws(()=>new MoonrakerNetwork(new JsonRpcDispatcher(),{authorize(){},endpoints,redirect:{authorizationAvailable:()=>true}}),/conflicting/);
});
