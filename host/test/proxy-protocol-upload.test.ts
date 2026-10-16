import test from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest,IncomingMessage} from 'node:http';
import {Socket} from 'node:net';
import {mkdtemp,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
import {NativePrintUploads} from '../src/moonraker/native-print-uploads.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {PrintController} from '../src/operations/print.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {ApiKeyAuthorization,type AuthorizationOptions} from '../src/moonraker/api-key-authorization.ts';
import {MoonrakerNetwork} from '../src/moonraker/server.ts';
import {JsonRpcDispatcher} from '../src/moonraker/rpc.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {registerNativeFileInfo} from '../src/moonraker/native-print-uploads.ts';
import {proxyProtocol} from '../src/moonraker/proxy-address.ts';
const information={connected:false,state:'disconnected' as const,components:[],failedComponents:[],directories:[],warnings:[],version:'proxy-protocol-test',missingRequirements:[]};
async function fixture(options:Omit<AuthorizationOptions,'issuer'>={},useXheaders=true,octoprint=false){
 const root=await mkdtemp(join(tmpdir(),'proxy-protocol-')),database=await DatabaseStore.open({path:join(root,'db.sqlite')}),journal=await PrintJournal.open({path:join(root,'prints.sqlite'),deviceId:'proxy-protocol'}),files=await PublishedPrintFiles.open(join(root,'files')),gate=new MaintenanceGate(),controller=new PrintController({async prepare(){},async start(){throw new Error('Unexpected print');},async pause(){},async resume(){},async finish(){},async stop(){}},{maxNozzle:300,maxBed:130},{},{journal,maintenanceGate:gate}),uploads=new NativePrintUploads(files,gate,{stagingRoot:root,maxFileBytes:65536,maxUploads:1}),config=join(root,'moonraker.conf');
 await writeFile(config,'[server]\nhost: 127.0.0.1\nport: 0\nuse_xheaders: '+useXheaders+'\n[authorization]\ntrusted_clients:\n'+(options.trustedClients??['127.0.0.1']).map(value=>'    '+value).join('\n')+'\n'+(octoprint?'[octoprint_compat]\n':''));
 let server:ConfiguredMoonraker;
 try{server=await ConfiguredMoonraker.loadAuthorized(config,{information,database,authorization:{issuer:'http://printer.test',trustedClients:['127.0.0.1'],...options},nativeUploads:uploads,productPrint:controller,maintenanceGate:gate});}
 catch(error){await controller.retire();await uploads.close();await files.close();await journal.close();await database.close();await rm(root,{recursive:true,force:true});throw error;}
 const address=await server.start(),base='http://127.0.0.1:'+address.port;
 return {root,database,files,uploads,server,base,key:server.authorization!.localApiKey(),async close(){await server.close();await controller.retire();await uploads.close();await files.close();await journal.close();await database.close();await rm(root,{recursive:true,force:true});}};
}
async function upload(f:Awaited<ReturnType<typeof fixture>>,headers:Record<string,string>={},name='50% 文件.gcode',route='/server/files/upload'){
 const data='G1 X1.000001\n; exact bytes\n',form=new FormData();form.append('file',new Blob([data]),name);
 const encoded=new Request(f.base,{method:'POST',body:form}),body=Buffer.from(await encoded.arrayBuffer());
 return new Promise<{status:number;location:string|undefined;body:any}>((resolve,reject)=>{
  const request=httpRequest(f.base+route,{method:'POST',headers:{host:'printer.test:443','content-type':encoded.headers.get('content-type')!,'content-length':body.length,'x-api-key':f.key,...headers}},response=>{const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode!,location:response.headers.location,body:JSON.parse(Buffer.concat(chunks).toString())}));response.on('error',reject);});request.setTimeout(5000,()=>request.destroy(new Error('Upload test timeout')));request.on('error',reject);request.end(body);
 });
}
test('configured verified proxy produces HTTPS upload Location and retains published bytes',async()=>{
 const f=await fixture();try{const r=await upload(f,{'x-forwarded-proto':'http, https','x-forwarded-host':'evil.test','x-real-ip':'198.51.100.1'});assert.equal(r.status,201);assert.equal(r.location,'https://printer.test:443/server/files/gcodes/50%25%20%E6%96%87%E4%BB%B6.gcode');assert.equal(r.body.print_started,false);const path=new URL(r.location!).pathname;assert.equal(await (await fetch(f.base+path,{headers:{'x-api-key':f.key}})).text(),'G1 X1.000001\n; exact bytes\n');}finally{await f.close();}
});
test('OctoPrint upload alias uses the same verified protocol and file publication',async()=>{const f=await fixture({},true,true);try{const r=await upload(f,{'x-scheme':'https'},'alias.gcode','/api/files/local');assert.equal(r.status,201);assert.equal(r.location,'https://printer.test:443/api/files/moonraker/gcodes/alias.gcode');assert.equal(r.body.print_started,false);}finally{await f.close();}});
for(const [headers,scheme] of [
 [{'x-scheme':'https','x-forwarded-proto':'http'},'https'],
 [{'x-scheme':'https, http','x-forwarded-proto':'https'},'http'],
 [{'x-scheme':'bad','x-forwarded-proto':'https'},'http'],
 [{'x-scheme':'','x-forwarded-proto':'https'},'http'],
 [{'x-forwarded-proto':'HTTPS'},'http'],
 [{'x-forwarded-proto':'https, bad'},'http'],
 [{'forwarded':'proto=https','x-forwarded-host':'evil.test'},'http'],
] as [Record<string,string>,string][])test('proxy protocol follows pinned selection: '+JSON.stringify(headers),async()=>{const f=await fixture();try{const r=await upload(f,headers);assert.equal(r.status,201);assert.equal(new URL(r.location!).protocol,scheme+':');assert.equal(new URL(r.location!).hostname,'printer.test');assert(r.location!.startsWith(scheme+'://printer.test:443/'));}finally{await f.close();}});
test('disabled xheaders and untrusted peers cannot choose HTTPS despite valid API keys',async()=>{for(const [options,enabled] of [[{},false],[{trustedClients:['192.0.2.1']},true]] as [Omit<AuthorizationOptions,'issuer'>,boolean][]){const f=await fixture(options,enabled);try{const r=await upload(f,{'x-scheme':'https','x-forwarded-proto':'https'});assert.equal(r.status,201);assert.equal(new URL(r.location!).protocol,'http:');}finally{await f.close();}}});
test('invalid credentials still refuse publication behind a verified HTTPS proxy',async()=>{const f=await fixture();try{const r=await upload(f,{'x-api-key':'invalid','x-scheme':'https'});assert.equal(r.status,401);assert.equal(r.location,undefined);assert.equal(f.uploads.status.published,0);}finally{await f.close();}});
function incoming(){const socket=new Socket();Object.defineProperty(socket,'remoteAddress',{value:'127.0.0.1'});const request=new IncomingMessage(socket);request.headers={'x-scheme':'https'};return request;}
test('protocol selector bounds arrays and long headers while preserving the original request',()=>{const request=incoming();try{request.headers['x-scheme']=Array(2).fill('https');assert.equal(proxyProtocol(request),undefined);request.headers['x-scheme']=' '.repeat(4096)+'https';assert.equal(proxyProtocol(request),undefined);request.headers['x-scheme']='http, https';assert.equal(proxyProtocol(request),'https');assert.equal(proxyProtocol(request,false),undefined);assert.equal(request.socket.remoteAddress,'127.0.0.1');}finally{request.socket.destroy();}});
test('protocol and identity share one NSS result and an immutable request snapshot',async()=>{
 const root=await mkdtemp(join(tmpdir(),'protocol-cache-')),database=await DatabaseStore.open({path:join(root,'db.sqlite')}),reply=Promise.withResolvers<string|null>(),entered=Promise.withResolvers<void>();let lookups=0;
 const auth=await ApiKeyAuthorization.open(database,{issuer:'http://printer.test',trustedClients:['proxy.test'],trustedClientOptions:{lookup:{lookup(){lookups++;entered.resolve();return reply.promise;},async close(){reply.resolve(null);}}}}),request=incoming(),context={request,transport:'http' as const,signal:new AbortController().signal};
 try{const pending=auth.resolveRequestProtocol(context);await entered.promise;request.headers['x-scheme']='http';reply.resolve('proxy.test');assert.equal(await pending,'https');assert.equal((await auth.networkOptions.authorize!('server.info',{},context))?.username,'_TRUSTED_USER_');assert.equal(auth.resolveRequestProtocol(context),'https');assert.equal(lookups,1);}finally{reply.resolve(null);request.socket.destroy();await auth.close();await database.close();await rm(root,{recursive:true,force:true});}
});
for(const operation of ['abort','close'] as const)test('late protocol NSS cannot escape '+operation,async()=>{
 const root=await mkdtemp(join(tmpdir(),'protocol-cancel-')),database=await DatabaseStore.open({path:join(root,'db.sqlite')}),reply=Promise.withResolvers<string|null>(),entered=Promise.withResolvers<void>();
 const auth=await ApiKeyAuthorization.open(database,{issuer:'http://printer.test',trustedClients:['proxy.test'],trustedClientOptions:{lookup:{lookup(){entered.resolve();return reply.promise;},async close(){reply.resolve(null);}}}}),request=incoming(),controller=new AbortController();
 try{const pending=auth.resolveRequestProtocol({request,transport:'http',signal:controller.signal}),rejected=assert.rejects(Promise.resolve(pending));await entered.promise;if(operation==='abort')controller.abort(new Error('Caller closed'));else await auth.close();reply.resolve('proxy.test');await rejected;}finally{reply.resolve(null);request.socket.destroy();await auth.close();await database.close();await rm(root,{recursive:true,force:true});}
});
test('protocol NSS wait occupies original request capacity and expires before upload publication',{timeout:10000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'protocol-http-deadline-')),database=await DatabaseStore.open({path:join(root,'db.sqlite')}),files=await PublishedPrintFiles.open(join(root,'files')),uploads=new NativePrintUploads(files,new MaintenanceGate(),{stagingRoot:root,maxUploads:1}),reply=Promise.withResolvers<string|null>(),entered=Promise.withResolvers<void>();
 const auth=await ApiKeyAuthorization.open(database,{issuer:'http://printer.test',trustedClients:['proxy.test'],trustedClientOptions:{lookup:{lookup(){entered.resolve();return reply.promise;},async close(){reply.resolve(null);}}}}),rpc=new JsonRpcDispatcher(),endpoints=new EndpointRegistry(rpc);registerNativeFileInfo(endpoints,uploads);const network=new MoonrakerNetwork(rpc,{...auth.networkOptions,endpoints,nativeUploads:uploads,maxRequests:1,requestTimeoutMs:500}),address=await network.listen(),base='http://127.0.0.1:'+address.port;
 try{const form=new FormData();form.append('file',new Blob(['G1 X1\n']),'pending.gcode');const pending=fetch(base+'/server/files/upload',{method:'POST',body:form,headers:{'x-api-key':auth.localApiKey(),'x-scheme':'https'}});await entered.promise;const full=await fetch(base+'/server/files/list',{headers:{'x-api-key':auth.localApiKey()}});assert.equal(full.status,429);await full.arrayBuffer();const response=await pending;assert.equal(response.status,503);await response.arrayBuffer();reply.resolve('proxy.test');await new Promise(resolve=>setImmediate(resolve));assert.equal(uploads.status.published,0);assert.equal(uploads.status.pending,0);assert.equal(network.status.requests,0);assert.equal((await readdir(root)).some(name=>name.startsWith('anyraid-upload-')),false);}finally{reply.resolve(null);await network.close();await auth.close();await uploads.close();await files.close();await database.close();await rm(root,{recursive:true,force:true});}
});
async function pendingFixture(){
 const root=await mkdtemp(join(tmpdir(),'protocol-credential-')),database=await DatabaseStore.open({path:join(root,'db.sqlite')}),files=await PublishedPrintFiles.open(join(root,'files')),uploads=new NativePrintUploads(files,new MaintenanceGate(),{stagingRoot:root,maxUploads:1}),reply=Promise.withResolvers<string|null>(),entered=Promise.withResolvers<void>();let lookups=0;
 const auth=await ApiKeyAuthorization.open(database,{issuer:'http://printer.test',trustedClients:['proxy.test'],trustedClientOptions:{lookup:{lookup(){lookups++;entered.resolve();return reply.promise;},async close(){reply.resolve(null);}}}}),rpc=new JsonRpcDispatcher(),endpoints=new EndpointRegistry(rpc);registerNativeFileInfo(endpoints,uploads);const network=new MoonrakerNetwork(rpc,{...auth.networkOptions,endpoints,nativeUploads:uploads,requestTimeoutMs:1000}),address=await network.listen(),base='http://127.0.0.1:'+address.port;
 return {root,uploads,auth,network,reply,entered,get lookups(){return lookups;},post(key:string){const form=new FormData();form.append('file',new Blob(['G1 X1\n']),'never.gcode');return fetch(base+'/server/files/upload',{method:'POST',body:form,headers:{'x-api-key':key,'x-scheme':'https'}});},async close(){reply.resolve(null);await network.close();await auth.close();await uploads.close();await files.close();await database.close();await rm(root,{recursive:true,force:true});}};
}
test('invalid credentials are refused before protocol NSS work',async()=>{const f=await pendingFixture();try{const r=await f.post('invalid');assert.equal(r.status,401);await r.arrayBuffer();assert.equal(f.lookups,0);assert.equal(f.uploads.status.published,0);}finally{await f.close();}});
test('credentials revoked during protocol verification cannot authorize publication',async()=>{const f=await pendingFixture();try{const pending=f.post(f.auth.localApiKey());await f.entered.promise;await f.auth.rotate();f.reply.resolve('proxy.test');const r=await pending;assert.equal(r.status,401);await r.arrayBuffer();assert.equal(f.uploads.status.published,0);assert.equal((await readdir(f.root)).some(name=>name.startsWith('anyraid-upload-')),false);}finally{await f.close();}});
