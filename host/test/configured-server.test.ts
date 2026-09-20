import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WebSocket} from 'ws';
import {ConfiguredMoonraker,readNetworkBinding} from '../src/moonraker/configured-server.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {ApiError} from '../src/moonraker/rpc.ts';
import type {InformationSnapshot} from '../src/moonraker/metadata.ts';
const info=():InformationSnapshot=>({connected:false,state:'disconnected',components:['application'],failedComponents:[],directories:[],warnings:[],version:'node-test',missingRequirements:[]});
const authorize=(_m:unknown,_p:unknown,c:any)=>{if(c.request.headers['x-api-key']!=='test')throw new ApiError(401,'Unauthorized');};
async function fixture(text:string,run:(path:string)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'configured-server-test-'));try{const path=join(dir,'main.conf');await writeFile(path,text);await run(path);}finally{await rm(dir,{recursive:true,force:true});}}
test('network binding reads upstream defaults and rejects invalid or imprecise settings',()=>{
 const make=(server:Record<string,string>)=>new ConfigurationReader(new ConfigurationSource('/config/main.conf',{DEFAULT:{},server},[]));
 assert.deepEqual(readNetworkBinding(make({})),{host:'0.0.0.0',port:7125,maxConnections:50});
 for(const server of [{port:'-1'},{port:'65536'},{port:'9007199254740993'},{port:'1.5'},{host:' '},{host:'http://localhost'},{max_websocket_connections:'0'},{max_websocket_connections:'10001'}] as Record<string,string>[])assert.throws(()=>readNetworkBinding(make(server)));
});
test('file-backed startup binds settings, metadata, authorization and actual WebSocket capacity',()=>fixture('[server]\nhost=127.0.0.1\nport=0\nmax_websocket_connections=1\n[consumer]\nspeed=120.5',async path=>{
 const service=await ConfiguredMoonraker.load(path,{authorize,information:info()});let ws:WebSocket|undefined;
 try{
  service.reader.section('consumer').getFloat('speed',{above:0});assert.equal(service.status.phase,'new');const opening=service.start();assert.equal(service.start(),opening);const address=await opening;assert.equal(address.address,'127.0.0.1');assert.ok(address.port>0);
  await rm(path);const url=`http://127.0.0.1:${address.port}`;assert.equal((await fetch(url+'/server/config')).status,401);
  let body:any=await (await fetch(url+'/server/config',{headers:{'x-api-key':'test'}})).json();assert.deepEqual(body.result.config,{server:{host:'127.0.0.1',port:0,max_websocket_connections:1},consumer:{speed:120.5}});assert.equal(body.result.orig.consumer.speed,'120.5');
  ws=new WebSocket(url.replace('http:','ws:')+'/websocket',{headers:{'x-api-key':'test'}});await once(ws,'open');const extra=new WebSocket(url.replace('http:','ws:')+'/websocket');await assert.rejects(once(extra,'open'),/503/);extra.terminate();
  body=await (await fetch(url+'/server/info',{headers:{'x-api-key':'test'}})).json();assert.equal(body.result.websocket_count,1);assert.equal(body.result.klippy_state,'disconnected');
  service.setInformation({...info(),connected:true,state:'shutdown'});body=await (await fetch(url+'/server/info',{headers:{'x-api-key':'test'}})).json();assert.equal(body.result.klippy_state,'shutdown');
 }finally{ws?.terminate();await service.close();}
 assert.equal(service.rpc.has('server.config'),false);assert.equal(service.rpc.has('server.websocket.id'),false);await service.close();await assert.rejects(service.start(),/stopping/);
}));
test('unused configuration warnings retain names without revealing values and survive lifecycle updates',()=>fixture('[server]\nhost=127.0.0.1\nport=0\nsecret=do-not-log\n[unknown]\npassword=private',async path=>{
 const service=await ConfiguredMoonraker.load(path,{authorize,information:info()});try{const address=await service.start();for(const state of ['disconnected','ready'] as const){service.setInformation({...info(),connected:state==='ready',state});const body:any=await(await fetch(`http://127.0.0.1:${address.port}/server/info`,{headers:{'x-api-key':'test'}})).json();assert.equal(body.result.warnings.length,2);assert.match(body.result.warnings.join(),/secret/);assert.equal(body.result.warnings.join().includes('do-not-log'),false);}}finally{await service.close();}
}));
test('occupied port failure closes owned resources and unregisters metadata',()=>fixture('[server]\nhost=127.0.0.1\nport=0',async path=>{
 const blocker=createServer();blocker.listen(0,'127.0.0.1');await once(blocker,'listening');const port=(blocker.address() as any).port;await writeFile(path,`[server]\nhost=127.0.0.1\nport=${port}`);
 const service=await ConfiguredMoonraker.load(path,{authorize,information:info()});try{await assert.rejects(service.start(),/EADDRINUSE/);assert.equal(service.status.phase,'closed');assert.equal(service.rpc.has('server.info'),false);await service.close();}finally{await new Promise<void>(resolve=>blocker.close(()=>resolve()));}
}));
test('startup and shutdown race does not leak a listener or claim startup success',()=>fixture('[server]\nhost=127.0.0.1\nport=0',async path=>{
 const service=await ConfiguredMoonraker.load(path,{authorize,information:info()});const opening=service.start(),rejected=assert.rejects(opening,/cancelled/);await service.close();await rejected;assert.equal(service.status.phase,'closed');assert.equal(service.status.connections,0);assert.equal(service.rpc.has('server.config'),false);
}));
test('configuration errors and missing authorization reject before a listener is constructed',()=>fixture('[server]\nport=not-a-number',async path=>{
 await assert.rejects(ConfiguredMoonraker.load(path,{authorize,information:info()}));await assert.rejects(ConfiguredMoonraker.load(path,{information:info()} as any),/authorization/);
}));
test('failed shutdown retains owned registrations until active requests actually settle',()=>fixture('[server]\nhost=127.0.0.1\nport=0',async path=>{
 const service=await ConfiguredMoonraker.load(path,{authorize,information:info(),shutdownTimeoutMs:20});let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),blocked=new Promise<void>(r=>release=r);
 service.rpc.register('server.slow',['http'],async()=>{entered();await blocked;return null;});
 try{const address=await service.start(),pending=fetch(`http://127.0.0.1:${address.port}/server/jsonrpc`,{method:'POST',headers:{'content-type':'application/json','x-api-key':'test'},body:JSON.stringify({jsonrpc:'2.0',method:'server.slow',id:1})}).catch(()=>null);await started;await assert.rejects(service.close(),/shutdown deadline/);assert.equal(service.status.phase,'closing');assert.equal(service.rpc.has('server.config'),true);release();await pending;await service.close();assert.equal(service.rpc.has('server.config'),false);assert.equal(service.status.phase,'closed');}finally{release?.();await service.close();}
}));
test('invalid configured Klippy path fails load before network startup',()=>fixture('[server]\nhost=127.0.0.1\nport=0\nklippy_uds_address={data_path}/klippy.sock',async path=>{
 await assert.rejects(ConfiguredMoonraker.load(path,{authorize,information:info(),klippy:{}}),/renderer/);await assert.rejects(ConfiguredMoonraker.load(path,{authorize,information:info(),klippy:{retryDelayMs:0}}),/retry/);
}));
