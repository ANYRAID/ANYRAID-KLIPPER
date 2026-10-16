import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {PrintController,type PrintDevice} from '../src/operations/print.ts';
import {HistoryFields} from '../src/moonraker/history-fields.ts';
import {NativeHistoryFields} from '../src/moonraker/native-history-fields.ts';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
import {NativePrintUploads} from '../src/moonraker/native-print-uploads.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {mqttPeer} from './helpers/mqtt-peer.ts';
import type {Json} from '../src/moonraker/rpc.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {configureNativeSensors} from '../src/moonraker/native-sensor-config.ts';
const request={version:1 as const,requestId:'job',fileId:'file',nozzle:0,bed:0};
const limits={maxNozzle:300,maxBed:120};
function value(item:Json):Json{assert(item!==null&&typeof item==='object'&&!Array.isArray(item));return item.value;}
const device:PrintDevice={async prepare(){},async start(){},async pause(){},async resume(){},async finish(){},async stop(){}};
async function until(condition:()=>boolean){const deadline=performance.now()+3000;while(!condition()){assert(performance.now()<deadline,'condition timed out');await new Promise(resolve=>setTimeout(resolve,2));}}
async function fixture(work:(journal:PrintJournal,root:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'native-fields-')),journal=await PrintJournal.open({path:join(root,'jobs.db'),deviceId:'printer'});try{await work(journal,root);}finally{await journal.close();await rm(root,{recursive:true,force:true});}}
test('native fields use acknowledged pauses and freeze before the terminal commit',()=>fixture(async journal=>{
 const pause=Promise.withResolvers<void>(),resume=Promise.withResolvers<void>(),finish=Promise.withResolvers<void>(),commit=Promise.withResolvers<void>();let finishing=false,committing=false;
 const controller=new PrintController({...device,async pause(){await pause.promise;},async resume(){await resume.promise;},async finish(){finishing=true;await finish.promise;}},limits,{},{journal});
 const owner=new NativeHistoryFields(),all=owner.fields.register({provider:'sensor room',name:'all',description:'all',strategy:'accumulate',reportTotal:true}),active=owner.fields.register({provider:'sensor room',name:'active',description:'active',strategy:'accumulate',excludePaused:true,reportTotal:true});owner.bind(controller);
 const sample=(value:number)=>{all.tracker.update(value);active.tracker.update(value);};
 const transition=journal.transition.bind(journal);journal.transition=async(...args)=>{if(args[2]==='completed'){committing=true;await commit.promise;}return transition(...args);};
 try{
  sample(100);await controller.start(request);sample(1);await controller.start(request);assert.equal(all.tracker.value,1);
  const pausing=controller.pause();await until(()=>controller.state==='pausing');sample(2);pause.resolve();await pausing;sample(3);
  const resuming=controller.resume();await until(()=>controller.state==='resuming');sample(4);resume.resolve();await resuming;sample(5);
  const completed=controller.complete('job');await until(()=>finishing);sample(6);finish.resolve();await until(()=>committing);assert.equal(controller.historyTrackingEnabled(false),false);sample(100);commit.resolve();await completed;
  const record=await journal.historyGet('1');assert.deepEqual(record!.auxiliary!.data.map((value:any)=>value.value),[21,14]);assert.deepEqual((await journal.historyTotals()).auxiliary_totals.map(value=>value.total),[21,14]);
  assert.throws(()=>owner.fields.register({provider:'late',name:'field',description:'late',strategy:'basic'}),/sealed/);
 }finally{pause.resolve();resume.resolve();finish.resolve();commit.resolve();await controller.retire();}
}));
test('rejected persisted identity restores the preceding fields and causes no preparation',()=>fixture(async journal=>{
 await journal.reserve(request);await journal.transition('job',1,'cancelled');let prepared=0;
 const controller=new PrintController({...device,async prepare(){prepared++;}},limits,{},{journal}),fields=new HistoryFields(exclude=>controller.historyTrackingEnabled(exclude));
 const field=fields.register({provider:'fixture',name:'amount',description:'amount',strategy:'accumulate',reset:()=>2});field.tracker.reset();controller.bindHistoryFields(fields);
 try{await assert.rejects(controller.start(request),/reconciliation/);assert.equal(field.tracker.value,2);assert.equal(prepared,0);assert.equal(controller.historyTrackingEnabled(false),false);assert.equal((await journal.historyTotals()).job_totals.total_jobs,1);}finally{await controller.retire();}
}));
test('multi-provider reset failure is atomic before reservation and device effects',()=>fixture(async journal=>{
 let bad=false,prepared=0;const controller=new PrintController({...device,async prepare(){prepared++;}},limits,{},{journal}),fields=new HistoryFields(exclude=>controller.historyTrackingEnabled(exclude));
 const first=fields.register({provider:'one',name:'value',description:'one',strategy:'accumulate',reset:()=>bad?0:7}),second=fields.register({provider:'two',name:'value',description:'two',strategy:'accumulate',reset:()=>{if(bad)throw new Error('reset failed');return 8;}});fields.reset();bad=true;controller.bindHistoryFields(fields);
 try{await assert.rejects(controller.start(request),/reset failed/);assert.deepEqual([first.tracker.value,second.tracker.value],[7,8]);assert.equal(await journal.get('job'),null);assert.equal(prepared,0);}finally{await controller.retire();}
}));
test('fault capture precedes pending safety cleanup and cancellation cannot recount it',()=>fixture(async journal=>{
 const stopped=Promise.withResolvers<void>();let stopping=false;const controller=new PrintController({...device,async stop(){stopping=true;await stopped.promise;}},limits,{},{journal}),owner=new NativeHistoryFields(),field=owner.fields.register({provider:'fault',name:'value',description:'fault',strategy:'accumulate',reportTotal:true});owner.bind(controller);
 try{await controller.start(request);field.tracker.update(2.675);const fault=controller.fault(new Error('device fault'));await until(()=>stopping);field.tracker.update(100);stopped.resolve();await fault;assert.equal(value((await journal.historyGet('1'))!.auxiliary!.data[0]),2.675);await controller.cancel();assert.equal((await journal.historyTotals()).auxiliary_totals[0].total,2.675);}finally{stopped.resolve();await controller.retire();}
}));
test('snapshot failure still stops the device and rejects persistence without leaving a pending fault',()=>fixture(async journal=>{
 let stops=0;const controller=new PrintController({...device,async stop(){stops++;}},limits,{},{journal}),owner=new NativeHistoryFields();owner.fields.register({provider:'failure',name:'field',description:'failure',strategy:'basic'});owner.bind(controller);
 try{await controller.start(request);owner.fields.snapshot=()=>{throw new Error('snapshot failed');};const fault=controller.fault(new Error('device fault'));await assert.rejects(fault,/snapshot failed/);assert.equal(stops,1);assert.equal(controller.historyTrackingEnabled(false),false);assert.equal((await journal.get('job'))!.state,'started');}finally{await controller.retire();}
}));
test('restoration retains persisted initial fields and never captures a new generation on acknowledgement',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-fields-restore-')),options={path:join(root,'jobs.db'),deviceId:'printer'};let journal=await PrintJournal.open(options);
 try{await journal.reserve(request,{data:[{provider:'old',name:'value',value:7}],totals:[]});await journal.close();journal=await PrintJournal.open(options);const controller=await PrintController.restore(device,limits,{},{journal}),owner=new NativeHistoryFields(),field=owner.fields.register({provider:'new',name:'value',description:'new',strategy:'accumulate',reset:()=>100,reportTotal:true});owner.bind(controller);
  try{field.tracker.reset();await controller.cancel();assert.deepEqual((await journal.historyGet('1'))!.auxiliary!.data,[{provider:'old',name:'value',value:7}]);assert.deepEqual((await journal.historyTotals()).auxiliary_totals,[]);}finally{await controller.retire();}
 }finally{await journal.close();await rm(root,{recursive:true,force:true});}
});
test('provider registry cannot be borrowed by two controllers and transfers only after retirement',()=>fixture(async(journal,root)=>{
 const owner=new NativeHistoryFields(),field=owner.fields.register({provider:'one',name:'value',description:'one',strategy:'accumulate',reportTotal:true}),one=new PrintController(device,limits,{},{journal}),otherJournal=await PrintJournal.open({path:join(root,'other.db'),deviceId:'other'}),two=new PrintController(device,limits,{},{journal:otherJournal});owner.bind(one);
 try{assert.throws(()=>owner.bind(two),/unbound/);await one.start(request);field.tracker.update(3);await one.complete('job');await one.retire();owner.bind(two);await two.start({...request,requestId:'second'});field.tracker.update(4);await two.complete('second');assert.equal(value((await otherJournal.historyGet('1'))!.auxiliary!.data[0]),4);assert.equal(value((await journal.historyGet('1'))!.auxiliary!.data[0]),3);}finally{await one.retire();await two.retire();await otherJournal.close();}
}));
test('configured native sensor and provider fields persist through actual MQTT and protected history routes',()=>fixture(async(journal,root)=>{
 const peer=await mqttPeer(),file=join(root,'moonraker.conf');await writeFile(file,`[server]\nhost: 127.0.0.1\nport: 0\n[mqtt]\naddress: 127.0.0.1\nport: ${peer.port}\n[sensor room]\ntype: MQTT\nstate_topic: room/telemetry\nstate_response_template: {set_result("t",payload|float)}\nhistory_field_temperature:\n  parameter=t\n  strategy=accumulate\n  exclude_paused=true\n  report_total=true\n`);
 const gate=new MaintenanceGate(),controller=new PrintController(device,limits,{},{journal,maintenanceGate:gate}),files=await PublishedPrintFiles.open(join(root,'files')),uploads=new NativePrintUploads(files,gate,{stagingRoot:root});let custom:ReturnType<HistoryFields['register']>|undefined,service:ConfiguredMoonraker|undefined;
 try{
  service=await ConfiguredMoonraker.load(file,{information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'test',missingRequirements:[]},authorize(_method,_params,context){if(context.request.headers['x-api-key']!=='test')throw new Error('unauthorized');},templates:{dataPath:root},productPrint:controller,maintenanceGate:gate,nativeUploads:uploads,nativeHistoryAuxiliary(fields){custom=fields.register({provider:'product',name:'energy',description:'energy',strategy:'accumulate',reportTotal:true});}});
  const {port}=await service.start(),base=`http://127.0.0.1:${port}`,headers={'x-api-key':'test'};
  const sample=async(value:number)=>{const n=service!.sensorTransportStatus!.messages;peer.publish('room/telemetry',String(value));await until(()=>service!.sensorTransportStatus!.messages===n+1);};
  await sample(100);await controller.start(request);await sample(2);custom!.tracker.update(1.25);await controller.pause();await sample(100);custom!.tracker.update(2.5);await controller.resume();await sample(3);await controller.complete('job');await sample(100);
  const response=await fetch(base+'/server/history/job?uid=1',{headers});assert.equal(response.status,200);const job=(await response.json() as any).result.job;assert.deepEqual(job.auxiliary_data.map((v:any)=>[v.provider,v.value]),[['sensor room',5],['product',3.75]]);
  assert.notEqual((await fetch(base+'/server/history/reset_totals',{method:'POST'})).status,200);const reset=await fetch(base+'/server/history/reset_totals',{method:'POST',headers});assert.equal(reset.status,200);assert.deepEqual((await journal.historyTotals()).auxiliary_totals.map(v=>v.total),[0,0]);assert.equal(value((await journal.historyGet('1'))!.auxiliary!.data[0]),5);
  await service.close();await controller.retire();assert.equal(service.sensorTransportStatus!.closed,true);assert.equal(value((await journal.historyGet('1'))!.auxiliary!.data[1]),3.75);
 }finally{await service?.close();await controller.retire();await uploads.close();await files.close();await peer.close();}
}));
for(const mode of ['async','duplicate','capacity'] as const)test(`native provider assembly rejects ${mode} before opening the broker`,()=>fixture(async(journal,root)=>{
 const peer=await mqttPeer(),file=join(root,'moonraker.conf'),gate=new MaintenanceGate(),controller=new PrintController(device,limits,{},{journal,maintenanceGate:gate}),files=await PublishedPrintFiles.open(join(root,'files')),uploads=new NativePrintUploads(files,gate,{stagingRoot:root});
 await writeFile(file,`[server]\nhost: 127.0.0.1\nport: 0\n[mqtt]\naddress: 127.0.0.1\nport: ${peer.port}\n[sensor room]\ntype: MQTT\nstate_topic: room/telemetry\nstate_response_template: {set_result("t",payload|float)}\nhistory_field_t:\n  parameter=t\n  strategy=accumulate\n`);
 const register=(fields:HistoryFields)=>{if(mode==='async')return Promise.resolve() as any;for(let i=0;i<(mode==='capacity'?64:1);i++)fields.register({provider:mode==='duplicate'?'sensor room':'product',name:mode==='duplicate'?'t':'f'+i,description:'field',strategy:'basic'});};
 try{await assert.rejects(ConfiguredMoonraker.load(file,{information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'test',missingRequirements:[]},authorize(){},templates:{dataPath:root},productPrint:controller,maintenanceGate:gate,nativeUploads:uploads,nativeHistoryAuxiliary:register}),mode==='async'?/synchronous/:mode==='duplicate'?/already registered/:/capacity/);assert.equal(peer.packets.length,0);assert.equal(journal.closed,false);assert.equal(await journal.get('job'),null);}finally{await controller.retire();await uploads.close();await files.close();await peer.close();}
}));
test('failed sensor template assembly restores a borrowed registry without closing its existing provider',()=>fixture(async(_journal,root)=>{
 const fields=new HistoryFields(()=>true),existing=fields.register({provider:'product',name:'kept',description:'kept',strategy:'accumulate'});existing.tracker.update(7);
 const reader=new ConfigurationReader(new ConfigurationSource(join(root,'moonraker.conf'),{DEFAULT:{},server:{},'sensor room':{type:'MQTT',state_topic:'room/telemetry',state_response_template:'{%',history_field_t:'parameter=t\nstrategy=accumulate'}},[]));
 assert.throws(()=>configureNativeSensors(reader,()=>true,{host:'127.0.0.1',port:1883},fields),/Invalid sensor template/);assert.deepEqual(fields.configuration.map(field=>field.provider),['product']);assert.equal(existing.tracker.value,7);existing.tracker.update(2);assert.equal(existing.tracker.value,9);
}));
