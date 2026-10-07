import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {once} from 'node:events';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {WebSocket} from 'ws';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {ApiKeyAuthorization} from '../src/moonraker/api-key-authorization.ts';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
import {ProductClientGateway} from '../src/runtime/product-client-gateway.ts';
// Retain the original moonraker-network benchmark's per-sample message counts,
// fixture value and 16-way concurrency. Compare native JWT directly versus the
// same native JWT identity through the browser gateway; no Python baseline.
const root=await mkdtemp(join(tmpdir(),'client-gateway-bench-')),db=await DatabaseStore.open({path:join(root,'auth.sqlite')}),auth=await ApiKeyAuthorization.open(db,{issuer:'http://printer.test',forceLogins:true}),config=join(root,'moonraker.conf'),origin='http://127.0.0.1:18420';let server:ConfiguredMoonraker|undefined,gateway:ProductClientGateway|undefined;const sockets:WebSocket[]=[];
try{
 const sampleCount=Number(process.env.BENCH_SAMPLES??11);if(!Number.isSafeInteger(sampleCount)||sampleCount<11||sampleCount>101)throw new Error('BENCH_SAMPLES must be an integer between 11 and 101');
 await writeFile(config,'[server]\nhost: 127.0.0.1\nport: 0\n');server=await ConfiguredMoonraker.load(config,{information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'gateway-bench',missingRequirements:[]},...auth.networkOptions});auth.register(server.endpoints);server.endpoints.register({endpoint:'/server/echo',methods:['GET','POST']},p=>p);server.endpoints.dispatcher.register('gateway.bench.echo',['http','websocket'],p=>p);const address=await server.start(),native='http://127.0.0.1:'+address.port;
 const http=async(base:string,path:string,headers:Record<string,string>,body?:object)=>new Promise<{result:any;cookie:string|undefined}>((resolve,reject)=>{const q=request(base+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',...headers}},r=>{let text='';r.setEncoding('utf8');r.on('data',s=>text+=s);r.once('end',()=>{try{assert.equal(r.statusCode,200);resolve({result:JSON.parse(text).result,cookie:r.headers['set-cookie']?.[0]});}catch(e){reject(e);}});});q.once('error',reject);q.end(body?JSON.stringify(body):undefined);});
 const user=(await http(native,'/access/user',{'x-api-key':auth.localApiKey()},{username:'operator',password:'benchmark-fixture'})).result;
 gateway=new ProductClientGateway({origin,upstream:native,loopbackHttp:true});const exposed=await gateway.listen(0),proxy='http://127.0.0.1:'+exposed.port;
 const session=await http(proxy,'/_client/session',{host:new URL(origin).host,origin},{username:'operator',password:'benchmark-fixture'});assert(session.cookie);const targets=[{name:'native-jwt',base:native,headers:{authorization:'Bearer '+user.token} as Record<string,string>},{name:'protected-gateway',base:proxy,headers:{host:new URL(origin).host,origin,cookie:session.cookie.split(';')[0]} as Record<string,string>}];
 const results:unknown[]=[];
 for(const target of targets){
  const socket=new WebSocket(target.base.replace('http:','ws:')+'/websocket',{headers:target.headers});sockets.push(socket);await once(socket,'open');const pending=new Map<number,ReturnType<typeof Promise.withResolvers<any>>>();let sequence=0;
  socket.on('message',data=>{const result=JSON.parse(String(data)),wait=pending.get(result.id);if(!wait)return;pending.delete(result.id);if(result.error)wait.reject(Error('Native RPC rejected benchmark request'));else wait.resolve(result.result);});
  const call=()=>{const id=++sequence,wait=Promise.withResolvers<any>();pending.set(id,wait);socket.send(JSON.stringify({jsonrpc:'2.0',id,method:'gateway.bench.echo',params:{value:123}}));return wait.promise;};
  const samples:Record<string,number[]>={rest:[],http:[],websocket:[],concurrent:[]},latencies:Record<string,number[]>={rest:[],http:[],websocket:[],concurrent:[]},loop=monitorEventLoopDelay({resolution:1});loop.enable();const cpu=process.cpuUsage();
  for(let round=0;round<sampleCount+3;round++){
   for(const [kind,count] of [['rest',200],['http',200],['websocket',500],['concurrent',20]] as const){const begin=performance.now();for(let i=0;i<count;i++){const start=performance.now();if(kind==='rest')assert.equal((await http(target.base,'/server/echo?value:int=123',target.headers)).result.value,123);else if(kind==='http')assert.equal((await http(target.base,'/server/jsonrpc',target.headers,{jsonrpc:'2.0',id:1,method:'gateway.bench.echo',params:{value:123}})).result.value,123);else if(kind==='websocket')assert.equal((await call()).value,123);else{const replies=await Promise.all(Array.from({length:16},()=>call()));assert(replies.every(r=>r.value===123));}if(round>=3)latencies[kind].push(performance.now()-start);}if(round>=3)samples[kind].push(performance.now()-begin);}
  }
  loop.disable();const summary=(numbers:number[])=>{const sorted=[...numbers].sort((a,b)=>a-b);return {count:sorted.length,medianMs:sorted[Math.floor((sorted.length-1)/2)],p95Ms:sorted[Math.ceil(sorted.length*.95)-1],p99Ms:sorted[Math.ceil(sorted.length*.99)-1],maxMs:sorted.at(-1)};};
  results.push({target:target.name,samples:Object.fromEntries(Object.entries(samples).map(([k,v])=>[k,{rawMs:v,...summary(v)}])),requests:Object.fromEntries(Object.entries(latencies).map(([k,v])=>[k,summary(v)])),eventLoop:{p99Ms:loop.percentile(99)/1e6,maxMs:loop.max/1e6},cpu:process.cpuUsage(cpu),rss:process.memoryUsage().rss});socket.terminate();assert.equal(pending.size,0);
 }
 console.log(JSON.stringify({node:process.version,perSample:{rest:200,http:200,websocket:500,concurrent:320,concurrency:16},warmups:3,samples:sampleCount,results,scope:'Sequential one-pair desktop comparison, same native account and handlers; actual HTTP/WS and bounded relay. Native server/gateway/client share this Node process with SQLite worker; production separate-process, mixed printing, TLS, target-board and statistical speed/zero-regression claims excluded. Original protocol benchmark has no timing pass threshold.'},null,2));
}finally{for(const ws of sockets)ws.terminate();await gateway?.close();await server?.close();await auth.close();await db.close();await rm(root,{recursive:true,force:true});}
