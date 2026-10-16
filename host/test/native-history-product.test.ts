import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createNativeProductHostFactory} from '../src/runtime/native-product-machine.ts';
import {runProductHost,type ProductHostFactory} from '../src/runtime/product-host.ts';
import {ProductHostControl} from '../src/runtime/product-host-control.ts';
import {productMachineFixture} from './helpers/product-machine.ts';
import {mqttPeer} from './helpers/mqtt-peer.ts';
import type {HistoryField} from '../src/moonraker/history-fields.ts';
async function until(check:()=>boolean){const deadline=performance.now()+5000;while(!check()){assert(performance.now()<deadline,'product condition timed out');await new Promise(resolve=>setTimeout(resolve,5));}}
test('ordinary native process owns configured history across preparation, cancellation and device replacement',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-history-product-')),peer=await mqttPeer(),control=new ProductHostControl(),abort=new AbortController(),ready=Promise.withResolvers<string>(),fixtures:Awaited<ReturnType<typeof productMachineFixture>>[]=[];
 let current=await productMachineFixture(root),energy:HistoryField|undefined,registrations=0,devices=0,held=Promise.withResolvers<void>(),preparing=false;fixtures.push(current);
 const config=`[server]\nhost: 127.0.0.1\nport: 0\n[mqtt]\naddress: 127.0.0.1\nport: ${peer.port}\n[sensor room]\ntype: MQTT\nstate_topic: room/telemetry\nstate_response_template: {set_result("t",payload|float)}\nhistory_field_temperature:\n  parameter=t\n  strategy=accumulate\n  report_total=true\n`;
 await writeFile(current.config.moonrakerConfig,config);
 const native=createNativeProductHostFactory(current.path,{dataPath:join(root,'private'),filesRoot:join(root,'files'),metadataRoot:join(root,'metadata'),standardPrint:{nozzle:0,bed:0},
  async createProcess(){return {server:{systemServices:{source:async()=>({provider:'none' as const,available_services:[],service_state:{},instance_ids:{moonraker:'',klipper:''}})},information:current.bindings.server.information,authorize(_m,_p,context){assert.equal(context.request.headers['x-api-key'],'test');},authorizeNotification(){},nativeHistoryAuxiliary(fields){registrations++;energy=fields.register({provider:'product',name:'energy',description:'energy',strategy:'accumulate',reportTotal:true});}},async release(){}};},
  async createAdapter(){devices++;
   const owned=current;return {stops:owned.bindings.stops,output:owned.bindings.print.output,lifecycle:{...owned.bindings.print.lifecycle,async prepare(){preparing=true;await held.promise;}},async authorizePrintFile(){},release:()=>owned.close()};}
 });
 let profiles=0;
 const factory:ProductHostFactory=async(signal,context)=>{
  // Recreate the PTYs and write their paths before the profile reads its MCU
  // configuration; recreating inside createAdapter is already too late.
  if(profiles++){current=await productMachineFixture(root);fixtures.push(current);await writeFile(current.config.moonrakerConfig,config);held=Promise.withResolvers<void>();preparing=false;}
  return native(signal,context);
 };
 Object.defineProperty(factory,'serverLifetime',{value:native.serverLifetime});factory.bootstrap=native.bootstrap;factory.close=native.close;factory.resetFirmware=native.resetFirmware;
 const server=(await factory.bootstrap!(abort.signal,control)).server;
 const running=runProductHost(factory,abort.signal,address=>ready.resolve('http://127.0.0.1:'+address.port),control);void running.catch(ready.reject);
 try{
  const base=await ready.promise,headers={'x-api-key':'test'};
  const get=async(path:string)=>{const response=await fetch(base+path,{headers});assert.equal(response.status,200,path);return (await response.json() as any).result;};
  const post=async(path:string,body?:unknown)=>{const response=await fetch(base+path,{method:'POST',headers:{...headers,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});assert.equal(response.status,200,await response.clone().text());return (await response.json() as any).result;};
  const sample=async(n:number)=>{const before=server.sensorTransportStatus!.messages;peer.publish('room/telemetry',String(n));await until(()=>server.sensorTransportStatus!.messages===before+1);};
  const form=new FormData();form.append('file',new Blob(['G1 X1\n']),'part.gcode');form.append('file_id','file');assert.equal((await fetch(base+'/server/files/upload',{method:'POST',headers,body:form})).status,201);
  for(let i=0;i<2;i++){
   await sample(100);await post('/printer/print/start',{filename:'file.gcode'});await until(()=>preparing);await sample(i+2);energy!.tracker.update(i+1.25);
   const cancellation=post('/printer/print/cancel');void cancellation.catch(()=>{});
   const deadline=performance.now()+5000;while((await get('/printer/print/status')).state!=='cancelling'){assert(performance.now()<deadline);await new Promise(resolve=>setTimeout(resolve,5));}
   held.resolve();await cancellation;await until(()=>server.nativeHistoryStatus!.pending===0);
   const history=await get('/server/history/list');assert.equal(history.count,i+1);assert.equal(history.jobs[0].status,'cancelled');assert.deepEqual(history.jobs[0].auxiliary_data.map((field:any)=>field.value),[i+2,i+1.25]);
   if(i===0){await control.reinitialize();assert.equal(devices,2);assert.equal(registrations,1);assert.equal(server.sensorTransportStatus!.connections,1);}
  }
  assert.deepEqual((await get('/server/history/totals')).auxiliary_totals.map((field:any)=>field.total),[5,3.5]);
  await post('/server/history/reset_totals');assert.deepEqual((await get('/server/history/totals')).auxiliary_totals.map((field:any)=>field.total),[0,0]);assert.deepEqual((await get('/server/history/job?uid=1')).job.auxiliary_data.map((field:any)=>field.value),[2,1.25]);
  abort.abort();await running;assert.equal(server.sensorTransportStatus!.closed,true);assert.equal(registrations,1);
 }finally{held.resolve();abort.abort();await running.catch(()=>{});await factory.close!();await control.close();await peer.close();for(const fixture of fixtures)await fixture.close();await rm(root,{recursive:true,force:true});}
});
