import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {startConfiguredMachineService} from '../src/runtime/product-service.ts';
import {productHostFixture} from './helpers/product-host-profile.ts';
type Service=Awaited<ReturnType<typeof startConfiguredMachineService>>;
test('product service reuses a live authorized process server across real PTY MCU groups',async t=>{
 const root=await mkdtemp(join(tmpdir(),'server-generation-')),db=await DatabaseStore.open({path:join(root,'api.db')}),first=await productHostFixture(root),abort=new AbortController();
 let initial:Service|undefined,next:Service|undefined,fresh:typeof first|undefined,socket:WebSocket|undefined;
 const shared={information:first.profile.options.server.information,database:db,authorization:{issuer:'https://generation.invalid'}};
 try{
  initial=await startConfiguredMachineService(first.profile.reader,first.profile.policies,first.profile.product,{...first.profile.options,server:shared,serverLifetime:'process'},abort.signal);
  const key=initial.server.authorization!.localApiKey(),base=`http://127.0.0.1:${initial.address.port}`;
  const created=await (await fetch(base+'/access/user',{method:'POST',headers:{'x-api-key':key,'content-type':'application/json'},body:JSON.stringify({username:'operator',password:'test-only-password'})})).json() as any,headers={authorization:'Bearer '+created.result.token},events:any[]=[];
  socket=new WebSocket(base.replace('http:','ws:')+'/websocket',{headers});socket.on('message',bytes=>events.push(JSON.parse(bytes.toString())));await once(socket,'open');socket.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'server.connection.identify',params:{client_name:'product-generation',version:'1',type:'web',url:'https://generation.invalid'}}));
  const until=async(check:()=>boolean)=>{const end=performance.now()+4000;while(!check()){assert(performance.now()<end,'Product generation timeout');await delay(5);}};await until(()=>events.some(e=>e.id===1));
  await initial.close();assert.equal(initial.server.status.phase,'listening');assert.equal(db.status.closed,false);assert(first.transport.stops.every(n=>n===1));await first.profile.release();
  fresh=await productHostFixture(root);const begin=performance.now();next=await startConfiguredMachineService(fresh.profile.reader,fresh.profile.policies,fresh.profile.product,{...fresh.profile.options,server:shared,serverLifetime:'process',existingServer:initial.server},abort.signal);
  const replacementMs=performance.now()-begin;
  assert.equal(next.server,initial.server);assert.deepEqual(next.address,initial.address);assert.equal(next.server.authorization!.localApiKey(),key);assert.equal(socket.readyState,WebSocket.OPEN);assert.equal(next.server.nativeGenerationStatus?.generation,2);
  const info=(await (await fetch(base+'/server/info',{headers})).json() as any).result;assert.equal(info.native_host.ready,true);assert.equal(info.native_host.mcus.length,2);
  const queried=(await (await fetch(base+'/printer/objects/query?toolhead',{headers})).json() as any).result;assert(queried.status.toolhead);assert.equal((await fetch(base+'/printer/gcode/help',{headers})).status,200);assert.equal((await fetch(base+'/printer/settings/driver_current',{headers})).status,200);
  assert.equal((await fetch(base+'/server/database/compact',{method:'POST',headers})).status,200);assert.equal(first.profile.product.maintenanceGate.status.closed,true);assert.equal(next.server.maintenanceGate,fresh.profile.product.maintenanceGate);
  await initial.close();assert.equal(next.server.nativeGenerationStatus?.state,'attached');assert.equal((await fetch(base+'/printer/print/status',{headers})).status,200);
  await next.close();assert.equal(next.server.status.phase,'listening');assert(fresh.transport.stops.every(n=>n===1));assert.equal(db.status.closed,false);await fresh.profile.release();
  t.diagnostic(JSON.stringify({replacementMs,scope:'Product service with two simulated PTY MCU groups; same listener and native JWT database',firstStops:first.transport.stops,nextStops:fresh.transport.stops}));
  await next.server.close();assert.equal(db.status.closed,true);
 }finally{socket?.terminate();abort.abort();await next?.close().catch(()=>{});await initial?.close().catch(()=>{});await initial?.server.close().catch(()=>{});await fresh?.profile.release();await first.profile.release();await db.close();await rm(root,{recursive:true,force:true});}
});
test('reused server rejects a different database identity before acquiring new MCU hardware',async()=>{
 const root=await mkdtemp(join(tmpdir(),'server-generation-identity-')),db=await DatabaseStore.open({path:join(root,'api.db')}),other=await DatabaseStore.open({path:join(root,'other.db')}),first=await productHostFixture(root),abort=new AbortController();let initial:Service|undefined,fresh:typeof first|undefined;
 const shared={information:first.profile.options.server.information,database:db,authorization:{issuer:'https://generation.invalid'}};
 try{
  initial=await startConfiguredMachineService(first.profile.reader,first.profile.policies,first.profile.product,{...first.profile.options,server:shared,serverLifetime:'process'},abort.signal);await initial.close();await first.profile.release();fresh=await productHostFixture(root);
  await assert.rejects(startConfiguredMachineService(fresh.profile.reader,fresh.profile.policies,fresh.profile.product,{...fresh.profile.options,server:{...shared,database:other},serverLifetime:'process',existingServer:initial.server},abort.signal),/identity/);
  assert(fresh.transport.stops.every(n=>n===0));assert(fresh.transport.firmware.every(m=>m.stepperConfigs.length===0));assert.equal(initial.server.status.phase,'listening');assert.equal(db.status.closed,false);assert.equal(other.status.closed,false);
 }finally{abort.abort();await initial?.close();await initial?.server.close();await fresh?.profile.release();await first.profile.release();await db.close();await other.close();await rm(root,{recursive:true,force:true});}
});
