import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {performance} from 'node:perf_hooks';
import {WebSocket} from 'ws';
import {ConfiguredMoonraker,readNetworkBinding} from '../src/moonraker/configured-server.ts';
import {loadConfiguration} from '../src/moonraker/config-source.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {MoonrakerNetwork} from '../src/moonraker/server.ts';
import {ServerConfiguration,ServerInformation,registerServerMetadata,type InformationSnapshot} from '../src/moonraker/metadata.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher,ApiError} from '../src/moonraker/rpc.ts';
const information=():InformationSnapshot=>({connected:false,state:'disconnected',components:['application'],failedComponents:[],directories:[],warnings:[],version:'benchmark',missingRequirements:[]});
const authorize=(_m:unknown,_p:unknown,c:any)=>{if(c.request.headers['x-api-key']!=='benchmark')throw new ApiError(401,'Unauthorized');};
const dir=await mkdtemp(join(tmpdir(),'configured-network-bench-')),path=join(dir,'main.conf');
const text='[server]\nhost=127.0.0.1\nport=0\nmax_websocket_connections=50';
await writeFile(path,text);
async function manual(){const reader=new ConfigurationReader(await loadConfiguration(path)),binding=readNetworkBinding(reader),rpc=new JsonRpcDispatcher(),endpoints=new EndpointRegistry(rpc),info=new ServerInformation(information()),config=new ServerConfiguration(reader.snapshot()),network=new MoonrakerNetwork(rpc,{authorize,endpoints,maxConnections:binding.maxConnections});const release=registerServerMetadata(endpoints,info,config,()=>network.status.connections);return {async start(){reader.validate();reader.publish(config);info.replace({...information(),warnings:[...reader.warnings()]});return network.listen(binding.port,binding.host);},async close(){await network.close();release();}};}
async function configured(){return ConfiguredMoonraker.load(path,{authorize,information:information()});}
const factories={manual,configured},services:{close():Promise<void>}[]=[],sockets:WebSocket[]=[];
try{
 const clients:Record<string,{http:string;ws:WebSocket}>={};
 for(const name of ['manual','configured'] as const){const service=await factories[name]();services.push(service);const address=await service.start(),http=`http://127.0.0.1:${address.port}`,ws=new WebSocket(http.replace('http:','ws:')+'/websocket',{headers:{'x-api-key':'benchmark'}});sockets.push(ws);await once(ws,'open');clients[name]={http,ws};}
 await rm(path); // Both request paths must run without config filesystem access.
 const samples:Record<string,Record<string,number[]>>={manual:{http:[],ws:[],startup:[]},configured:{http:[],ws:[],startup:[]}};
 async function runHttp(name:string){const start=performance.now();for(let i=0;i<200;i++){const response=await fetch(clients[name].http+(i%2?'/server/info':'/server/config'),{headers:{'x-api-key':'benchmark'}});assert.equal(response.status,200);const data:any=await response.json();if(i%2){assert.equal(data.result.klippy_state,'disconnected');assert.equal(data.result.websocket_count,1);}else{assert.equal(data.result.config.server.port,0);assert.equal(data.result.config.server.max_websocket_connections,50);}}return performance.now()-start;}
 async function runWs(name:string){const ws=clients[name].ws,start=performance.now();for(let i=0;i<500;i++){const next=once(ws,'message');ws.send(JSON.stringify({jsonrpc:'2.0',method:i%2?'server.info':'server.config',id:i}));const result=JSON.parse(String((await next)[0]));assert.equal(result.id,i);assert.ok(result.result);}return performance.now()-start;}
 for(let run=0;run<14;run++)for(const name of run%2?['configured','manual']:['manual','configured']){const http=await runHttp(name),ws=await runWs(name);if(run>=3){samples[name].http.push(http);samples[name].ws.push(ws);}}
 for(const ws of sockets)ws.terminate();for(const service of services)await service.close();await writeFile(path,text);
 for(let run=0;run<14;run++)for(const name of (run%2?['configured','manual']:['manual','configured']) as ('manual'|'configured')[]){const start=performance.now();for(let i=0;i<30;i++){const service=await factories[name]();try{await service.start();}finally{await service.close();}}if(run>=3)samples[name].startup.push(performance.now()-start);}
 const results:Record<string,unknown>={};for(const [name,groups]of Object.entries(samples)){results[name]=Object.fromEntries(Object.entries(groups).map(([kind,times])=>{times.sort((a,b)=>a-b);return [kind,{medianMs:times[5],p95Ms:times[10]}];}));}
 console.log(JSON.stringify({node:process.version,httpRequests:200,websocketRequests:500,loadStartStopCycles:30,warmups:3,samples:11,results,scope:'Real localhost HTTP/WebSocket and file-load/listen/close cycles. Existing Node components assembled manually versus configured lifecycle. Alternating order, identical metadata and authorization callback; source file absent during steady-state requests. No Python daemon or hardware printing claim.'},null,2));
}finally{for(const ws of sockets)ws.terminate();for(const service of services)await service.close();await rm(dir,{recursive:true,force:true});}
