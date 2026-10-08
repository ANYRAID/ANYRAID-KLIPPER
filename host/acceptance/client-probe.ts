import {startCompiledClientHost} from '../test/helpers/compiled-client-host.ts';
import {createServer,request} from 'node:http';
import {mkdtemp,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {externalAcceptanceBundle,assertSeparateAcceptanceWorkspace,assertAcceptanceBundleUnchanged} from '../test/helpers/acceptance-bundle.ts';
import {join,extname,resolve} from 'node:path';
import {WebSocket,WebSocketServer} from 'ws';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {ApiKeyAuthorization} from '../src/moonraker/api-key-authorization.ts';
import {productMachineFixture} from '../test/helpers/product-machine.ts';
// Local UI acceptance only. All machine transports below come from the PTY fixture.
// No physical device path or production credential is accepted.
const assets=process.argv[2];if(!assets)throw new Error('Usage: node host/acceptance/client-probe.ts /absolute/frontend/assets');
const assetRoot=resolve(assets);await readFile(join(assetRoot,'index.html'));
const trustedLoopback=process.argv[4]==='--trusted-loopback';if(process.argv[4]&&!trustedLoopback||process.argv.length>5)throw new Error('Unknown client probe option');
const port=Number(process.argv[3]??18326);if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid loopback port');
const retained=await externalAcceptanceBundle();
const dir=await realpath(await mkdtemp(join(tmpdir(),'anyraid-client-data-')));
if(retained){try{await assertSeparateAcceptanceWorkspace(retained,dir);}catch(error){await rm(dir,{recursive:true,force:true});throw error;}}
const abort=new AbortController(),issuer='http://printer.test';const db=await DatabaseStore.open({path:join(dir,'auth.sqlite')}),api=await ApiKeyAuthorization.open(db,{issuer});const key=api.localApiKey();await api.close();await db.close();
// This is a short interactive check, not a long-running firmware simulator.
const deadline=setTimeout(()=>{console.log('CLIENT_TIMEOUT');abort.abort();},15*60*1000);
let upstream='';const sockets=new Set<WebSocket>(),wss=new WebSocketServer({noServer:true});
const server=createServer(async(req,res)=>{const path=new URL(req.url!,'http://localhost').pathname;if(/^\/(server|printer|machine|access)\//.test(path)){const proxy=request(upstream+req.url,{method:req.method,headers:req.headers},reply=>{console.log(JSON.stringify({http:path,status:reply.statusCode}));res.writeHead(reply.statusCode!,reply.headers);reply.pipe(res);});proxy.on('error',()=>{res.writeHead(502);res.end();});req.pipe(proxy);return;}
 let decoded:string;try{decoded=decodeURIComponent(path==='/'?'/index.html':path);}catch{res.writeHead(400);res.end();return;}const root=assetRoot,file=resolve(root,'.'+decoded);if(!file.startsWith(root+'/')){res.writeHead(403);res.end();return;}try{const data=await readFile(file);res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'} as Record<string,string>)[extname(file)]??'application/octet-stream');res.end(data);}catch{res.writeHead(404);res.end();}});
server.on('upgrade',(req,socket,head)=>{const peer=new WebSocket(upstream.replace('http:','ws:')+req.url);peer.on('error',()=>socket.destroy());peer.once('open',()=>wss.handleUpgrade(req,socket,head,client=>{sockets.add(client);sockets.add(peer);client.on('error',()=>peer.close());client.on('message',data=>{try{const value=JSON.parse(String(data));console.log(JSON.stringify({rpc:value.method}));}catch{}if(peer.readyState===WebSocket.OPEN)peer.send(data,{binary:false});});peer.on('message',data=>{try{const value=JSON.parse(String(data));if(value.error)console.log(JSON.stringify({rpcError:value.error,id:value.id}));}catch{}if(client.readyState===WebSocket.OPEN)client.send(data,{binary:false});});client.on('close',()=>{peer.close();sockets.delete(client);});peer.on('close',()=>{client.close();sockets.delete(peer);});}));});
server.on('error',()=>{console.error('Client proxy failed');abort.abort();});
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>abort.abort());
let host:Awaited<ReturnType<typeof startCompiledClientHost>>|undefined,bootstrap:Promise<void>=Promise.resolve(),initialized=false;
const fixture=await productMachineFixture(dir,false,'ack');let processGeneration=0,restartRequested=false;
console.log('CLIENT_PARENT '+process.pid);
// Test supervisor controls only; no product HTTP route or physical device.
process.on('SIGUSR1',()=>{if(!initialized||restartRequested||abort.signal.aborted)return;restartRequested=true;console.log('CLIENT_PROCESS_RESTART');void host?.close().catch(error=>{console.error(error);abort.abort();});});
process.on('SIGUSR2',()=>{if(!initialized||abort.signal.aborted)return;console.log('CLIENT_CONNECTIONS_DROPPED');for(const socket of sockets)socket.close(1012,'Local acceptance reconnect');});
try{
 do{restartRequested=false;processGeneration++;
 host=await startCompiledClientHost(dir,abort.signal,base=>{upstream=base;console.log('CLIENT_PROCESS_READY '+processGeneration);if(initialized)return;
  bootstrap=(async()=>{
   const response=await fetch(upstream+'/access/user',{method:'POST',headers:{'content-type':'application/json','x-api-key':key},body:JSON.stringify({username:'operator',password:'client-test-only'})});if(response.status!==200)throw new Error('User bootstrap failed');await response.arrayBuffer();
   const sample=new FormData();sample.append('file',new Blob(['G90\nG92 E0\n'+Array.from({length:1000},(_,i)=>'G1 X'+((i+1)/100)+' E'+((i+1)/1000)+' F60\n').join('')+'M400\n']),'client-sample.gcode');sample.append('file_id','client-sample');sample.append('root','gcodes');
   const uploaded=await fetch(upstream+'/server/files/upload',{method:'POST',headers:{'x-api-key':key},body:sample});if(uploaded.status!==201)throw new Error('Sample upload failed: HTTP '+uploaded.status);await uploaded.arrayBuffer();initialized=true;
   console.log('CLIENT_SAMPLE client-sample.gcode (seeded by API)');server.listen(port,'127.0.0.1',()=>console.log('CLIENT_READY http://127.0.0.1:'+port));
  })().catch(error=>{console.error(error);abort.abort();});
 },trustedLoopback,{fixture,reuseBuild:processGeneration>1});
 // Child ready is logged separately from initial proxy readiness, and the same
 // emitted app/storage/MCU objects are reused after verified child termination.
 console.log('CLIENT_PROCESS '+processGeneration);
 await host.lifetime;
 }while(restartRequested&&!abort.signal.aborted);
}finally{abort.abort();clearTimeout(deadline);await bootstrap;for(const socket of sockets)socket.terminate();server.close();wss.close();try{await host?.close();}finally{await fixture.close();await rm(dir,{recursive:true,force:true});if(retained)await assertAcceptanceBundleUnchanged(retained);}}
