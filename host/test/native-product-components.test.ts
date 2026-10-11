import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {inspect} from 'node:util';
import {createNativeProductHostFactory,type NativeProductProcessOptions} from '../src/runtime/native-product-machine.ts';
import {ProductHostControl} from '../src/runtime/product-host-control.ts';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
import {productMachineFixture} from './helpers/product-machine.ts';
import {mqttPeer} from './helpers/mqtt-peer.ts';
const signal=()=>new AbortController().signal;
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'native-components-')),machine=await productMachineFixture(root),dataPath=join(root,'private'),control=new ProductHostControl();await mkdir(dataPath);
 let releases=0,devices=0,opens=0;
 const options:NativeProductProcessOptions={dataPath,filesRoot:join(root,'files'),metadataRoot:join(root,'metadata'),async createProcess(){opens++;return {server:{information:machine.bindings.server.information,authorize(){},authorizeNotification(){}},async release(){releases++;}};},async createAdapter(){devices++;return {stops:machine.bindings.stops,lifecycle:machine.bindings.print.lifecycle,output:machine.bindings.print.output,async authorizePrintFile(){},async release(){}};}};
 return {root,machine,dataPath,control,options,get counts(){return {opens,devices,releases};},async close(){await control.close();await machine.close();await rm(root,{recursive:true,force:true});}};
}
test('process entry requires explicit data identity before acquiring dependencies',async()=>{
 const f=await fixture();try{
  for(const dataPath of [undefined,null,'relative','',join(f.root,'bad\0path'),join(f.root,'bad\npath'),'/'+'x'.repeat(4096),'/bad\ud800path'])assert.throws(()=>createNativeProductHostFactory(f.machine.path,{...f.options,dataPath} as any),/absolute data directory/);
  const {createProcess,...legacy}=f.options;assert.throws(()=>createNativeProductHostFactory(f.machine.path,legacy as any),/requires process lifetime/);assert.deepEqual(f.counts,{opens:0,devices:0,releases:0});await assert.rejects(access(f.options.filesRoot));
 }finally{await f.close();}
});
test('ordinary process startup loads private templates once, survives profile retirement, and closes with the server',async()=>{
 const f=await fixture();await writeFile(join(f.dataPath,'moonraker.secrets'),'{"marker":"original private generation"}');
 const factory=createNativeProductHostFactory(f.machine.path,f.options);let server:Awaited<ReturnType<NonNullable<typeof factory.bootstrap>>>['server']|undefined,profile:Awaited<ReturnType<typeof factory>>|undefined;
 try{
  const bootstrap=await factory.bootstrap!(signal(),f.control);server=bootstrap.server;assert.equal((await factory.bootstrap!(signal(),f.control)).server,server);const owner=server.templates!;assert(owner);assert.equal(owner.toJSON().asyncInitialized,false);
  const template=owner.createTemplate("{secrets.marker} / {data_path}");assert.equal(template.render(JSON.stringify({data_path:f.dataPath})),'original private generation / '+f.dataPath);
  const address=await server.start(),base=`http://127.0.0.1:${address.port}`;const info=await (await fetch(base+'/server/info')).json() as any;assert(info.result.components.includes('template'));assert(info.result.components.includes('secrets'));assert(!JSON.stringify(info).includes('original private generation'));assert(!inspect(owner).includes(f.dataPath));
  profile=await factory(signal());assert.deepEqual(profile.options.server.templates,{dataPath:f.dataPath});await profile.release();profile=undefined;
  await writeFile(join(f.dataPath,'moonraker.secrets'),'{"marker":"replacement on disk"}');f.options.dataPath=join(f.root,'changed-caller-context');
  profile=await factory(signal());assert.deepEqual(profile.options.server.templates,{dataPath:f.dataPath});assert.equal(server.templates,owner);assert.equal(template.render(JSON.stringify({data_path:f.dataPath})),'original private generation / '+f.dataPath);await profile.release();profile=undefined;assert.deepEqual(f.counts,{opens:1,devices:2,releases:0});
  await server.close();assert(owner.toJSON().closed);assert.throws(()=>template.render(),/closed/);await factory.close!();assert.deepEqual(f.counts,{opens:1,devices:2,releases:1});
  const reopened=await PublishedPrintFiles.open(f.options.filesRoot);await reopened.close();
 }finally{await profile?.release();await server?.close();await factory.close!();await f.close();}
});
test('private file startup failure releases process owners and never acquires a printer',async()=>{
 const f=await fixture();await writeFile(join(f.dataPath,'moonraker.secrets'),' '.repeat(1024*1024+1));const factory=createNativeProductHostFactory(f.machine.path,f.options);
 try{await assert.rejects(factory.bootstrap!(signal(),f.control),/bounded regular secrets/);assert.deepEqual(f.counts,{opens:1,devices:0,releases:0});await factory.close!();assert.deepEqual(f.counts,{opens:1,devices:0,releases:1});const reopened=await PublishedPrintFiles.open(f.options.filesRoot);await reopened.close();}
 finally{await factory.close!();await f.close();}
});
for(const alias of ['templates','templateSecrets'] as const)test(`process rejects competing ${alias} owner and cleans the returned dependency`,async()=>{
 const f=await fixture();const create=f.options.createProcess;f.options.createProcess=async(config,s)=>{const resources=await create(config,s);if(alias==='templates')resources.server.templates={dataPath:join(f.root,'other')};else resources.server={...resources.server,authorization:{issuer:'https://invalid.test',templateSecrets:{dataPath:join(f.root,'other')}}} as any;return resources;};const factory=createNativeProductHostFactory(f.machine.path,f.options);
 try{await assert.rejects(factory.bootstrap!(signal(),f.control),/owns template and secrets/);assert.equal(f.counts.devices,0);await factory.close!();assert.equal(f.counts.releases,1);}finally{await factory.close!();await f.close();}
});
test('product bootstrap owns configured MQTT across device profile replacement',async()=>{
 const f=await fixture(),peer=await mqttPeer();await writeFile(f.machine.config.moonrakerConfig,`[server]\nhost: 127.0.0.1\nport: 0\n[mqtt]\naddress: 127.0.0.1\nport: ${peer.port}\nusername: {secrets["username"]}\n[sensor room]\ntype: MQTT\nstate_topic: room/telemetry\nstate_response_template: {set_result("t",payload|float * (secrets["gain"]|float))}\n`);await writeFile(join(f.dataPath,'moonraker.secrets'),'{"username":"fixture-product-user","gain":"1.25"}');const factory=createNativeProductHostFactory(f.machine.path,f.options);let server:Awaited<ReturnType<NonNullable<typeof factory.bootstrap>>>['server']|undefined,profile:Awaited<ReturnType<typeof factory>>|undefined;
 try{server=(await factory.bootstrap!(signal(),f.control)).server;assert.equal(f.counts.devices,0);const address=await server.start();assert.equal(server.sensorTransportStatus?.connections,1);const owner=server.templates!;assert.equal(owner.toJSON().templates,1);
  const sample=async()=>{const before=server!.sensorTransportStatus!.messages;peer.publish('room/telemetry','4');const deadline=performance.now()+3000;while(server!.sensorTransportStatus!.messages===before){assert(performance.now()<deadline);await new Promise(r=>setTimeout(r,5));}const body=await(await fetch(`http://127.0.0.1:${address.port}/server/sensors/info?sensor=room`)).json() as any;assert.equal(body.result.values.t,5);};await sample();await writeFile(join(f.dataPath,'moonraker.secrets'),'{"username":"changed-user","gain":"99"}');
  for(let i=0;i<2;i++){profile=await factory(signal());await profile.release();profile=undefined;assert.equal(server.sensorTransportStatus?.closed,false);assert.equal(server.sensorTransportStatus?.connections,1);assert.equal(server.templates,owner);await sample();}assert.deepEqual(f.counts,{opens:1,devices:2,releases:0});
  await server.close();assert.equal(server.sensorTransportStatus?.closed,true);assert.equal(owner.toJSON().closed,true);assert.equal(owner.toJSON().templates,0);await factory.close!();assert.equal(f.counts.releases,1);
 }finally{await profile?.release();await server?.close();await factory.close!();await peer.close();await f.close();}
});
