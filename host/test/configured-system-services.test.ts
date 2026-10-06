import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WebSocket} from 'ws';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
import {ApiError} from '../src/moonraker/rpc.ts';
import type {ServiceSnapshot} from '../src/moonraker/system-services.ts';
const information={connected:false,state:'disconnected' as const,components:['application'],failedComponents:[],directories:[],warnings:[],version:'node-test',missingRequirements:[]};
const authorize=(_m:unknown,_p:unknown,c:any)=>{if(c.request.headers['x-api-key']!=='test')throw new ApiError(401,'Unauthorized');};
const snapshot=(active='active'):ServiceSnapshot=>({provider:'systemd_cli',available_services:['actual-native'],service_state:{'actual-native':{active_state:active,sub_state:active==='active'?'running':'dead'}},instance_ids:{moonraker:'actual-native',klipper:'actual-native'}});
test('service cache and deltas use authorized HTTP/RPC/real websocket fanout and close with the process owner',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'configured-services-'));const path=join(dir,'moonraker.conf');await writeFile(path,'[server]\nhost=127.0.0.1\nport=0');
 let calls=0,fail=false,next=snapshot();const clients:WebSocket[]=[];
 const service=await ConfiguredMoonraker.load(path,{authorize,authorizeNotification:(_m,_p,c)=>{if(c.connectionId!==service.clients[0]?.id)throw new ApiError(403,'Denied observer');},information,systemInformation:{source:async()=>({runtime:{name:'node'},network:{},canbus:{},provider:'none'})},systemServices:{source:async()=>{calls++;if(fail)throw new Error('private systemctl failure');return structuredClone(next);}}});
 try{
  const address=await service.start(),url=`http://127.0.0.1:${address.port}`;assert.equal(calls,1);assert.equal(service.systemServicesStatus!.notifications.received,0);
  const denied=await fetch(url+'/machine/system_info');assert.equal(denied.status,401);await denied.arrayBuffer();
  const result:any=await(await fetch(url+'/machine/system_info',{headers:{'x-api-key':'test'}})).json();assert.deepEqual(result.result.system_info,{runtime:{name:'node'},network:{},canbus:{},...snapshot()});assert.equal(calls,1);
  for(let i=0;i<2;i++){const ws=new WebSocket(url.replace('http:','ws:')+'/websocket',{headers:{'x-api-key':'test'}});clients.push(ws);await once(ws,'open');}
  const messages:any[][]=[[],[]];clients.forEach((ws,i)=>ws.on('message',data=>messages[i].push(JSON.parse(String(data)))));
  clients[0].send(JSON.stringify({jsonrpc:'2.0',id:7,method:'machine.system_info'}));const rpcDeadline=Date.now()+3000;while(!messages[0].some(m=>m.id===7)&&Date.now()<rpcDeadline)await new Promise(r=>setTimeout(r,10));assert.deepEqual(messages[0].find(m=>m.id===7).result,result.result);assert.equal(calls,1);
  next=snapshot('inactive');const changed=once(clients[0],'message',{signal:AbortSignal.timeout(5000)});const event=JSON.parse(String((await changed)[0]));assert.deepEqual(event,{jsonrpc:'2.0',method:'notify_service_state_changed',params:[{'actual-native':{active_state:'inactive',sub_state:'dead'}}]});
  const deadline=Date.now()+1000;while(!service.systemServicesStatus!.notifications.denied&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));assert.equal(service.systemServicesStatus!.notifications.sent,1);assert.equal(service.systemServicesStatus!.notifications.denied,1);assert.equal(messages[1].length,0);
  const updated:any=await(await fetch(url+'/machine/system_info',{headers:{'x-api-key':'test'}})).json();assert.deepEqual(updated.result.system_info.service_state,next.service_state);
  fail=true;const samples=service.systemServicesStatus!.samples;const failureDeadline=Date.now()+4000;while(!service.systemServicesStatus!.failures&&Date.now()<failureDeadline)await new Promise(r=>setTimeout(r,10));assert.equal(service.systemServicesStatus!.samples,samples);assert.equal(service.systemServicesStatus!.failures,1);
  const retained:any=await(await fetch(url+'/machine/system_info',{headers:{'x-api-key':'test'}})).json();assert.deepEqual(retained.result,updated.result);assert(!JSON.stringify(retained).includes('private systemctl failure'));assert.equal(service.rpc.has('machine.services.restart'),false);assert.equal(service.rpc.has('machine.reboot'),false);
 }finally{clients.forEach(ws=>ws.terminate());await service.close();await rm(dir,{recursive:true,force:true});}
 assert.equal(service.systemServicesStatus!.closed,true);assert.equal(service.systemServicesStatus!.pending,false);assert.equal(service.rpc.has('machine.system_info'),false);
});
test('invalid service configuration fails before listening; close joins startup cancellation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'configured-services-start-'));const path=join(dir,'moonraker.conf');await writeFile(path,'[server]\nhost=127.0.0.1\nport=0');
 try{
  await assert.rejects(ConfiguredMoonraker.load(path,{authorize,information,systemServices:{}}),/require system information/);
  await assert.rejects(ConfiguredMoonraker.load(path,{authorize,information,systemInformation:{},systemServices:{allowedUnits:['bad;reboot.service']}}),/allowed service units/);
  const pending=Promise.withResolvers<ServiceSnapshot>(),entered=Promise.withResolvers<void>();let aborted=false;
  const service=await ConfiguredMoonraker.load(path,{authorize,information,systemInformation:{source:async()=>({})},systemServices:{source:async signal=>{entered.resolve();signal.addEventListener('abort',()=>{aborted=true;});return pending.promise;}}});
  const opening=service.start(),rejected=assert.rejects(opening,/closed|cancelled/);await entered.promise;let closed=false;const close=service.close().then(()=>{closed=true;});await Promise.resolve();assert.equal(aborted,true);assert.equal(closed,false);pending.resolve(snapshot());await rejected;await close;assert.equal(service.systemServicesStatus!.samples,0);assert.equal(service.status.phase,'closed');
 }finally{await rm(dir,{recursive:true,force:true});}
});
