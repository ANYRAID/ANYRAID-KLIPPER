import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fixedInstallFixture} from './helpers/fixed-install.ts';
import {productMachineFixture} from './helpers/product-machine.ts';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {createNativeProductHostFactory} from '../src/runtime/native-product-machine.ts';
import {runProductHost} from '../src/runtime/product-host.ts';
import {ProductHostControl} from '../src/runtime/product-host-control.ts';
import type {MachineAction,MachineControlPort} from '../src/moonraker/machine-control.ts';
import {MoonrakerNetwork} from '../src/moonraker/server.ts';
import {CorsPolicy} from '../src/moonraker/cors-policy.ts';
import type {AddressInfo} from 'node:net';
import {request as httpsRequest} from 'node:https';
import {mqttCertificate} from './helpers/mqtt-certificate.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {loadConfiguration} from '../src/moonraker/config-source.ts';
import {readAuthorizationOptions} from '../src/moonraker/authorization-config.ts';
async function until(check:()=>boolean){const end=performance.now()+10000;while(!check()){assert(performance.now()<end,'Installation bootstrap timeout');await delay(5);}}
async function fixture(){const f=await fixedInstallFixture();await mkdir(join(f.root,'machine'));const machine=await productMachineFixture(join(f.root,'machine')),printerConfig=await readFile(machine.config.printerConfig,'utf8');machine.config.moonrakerConfig=f.configFile;machine.config.printerConfig=join(f.configRoot,'printer.cfg');machine.config.journalPath=join(f.dataPath,'print.sqlite');await writeFile(machine.config.printerConfig,printerConfig);await writeFile(machine.path,JSON.stringify(machine.config));await mkdir(join(f.dataPath,'metadata'),{mode:0o700});
 let devices=0,processes=0;const originalActions:MachineAction[]=[],addresses:string[]=[];
 const start=async()=>{const abort=new AbortController(),control=new ProductHostControl(),listening=Promise.withResolvers<string>();let db:DatabaseStore|undefined,secureBase:string|undefined;
  const original:MachineControlPort={retirement(action){if(action.kind==='service')return 'none';return 'process';},async execute(action){originalActions.push(action);},async assertDeviceAvailable(){},async close(){}};
  const factory=createNativeProductHostFactory(machine.path,{dataPath:f.dataPath,filesRoot:f.gcodesRoot,metadataRoot:join(f.dataPath,'metadata'),configFiles:{root:f.configRoot,writable:['moonraker.conf','printer.cfg']},installation:{options:f.options,backend:f.backend()},standardPrint:{nozzle:200,bed:60},
   async createProcess(){processes++;db=await DatabaseStore.open({path:f.databasePath});return {server:{systemServices:{source:async()=>({provider:'none' as const,available_services:[],service_state:{},instance_ids:{moonraker:'',klipper:''}})},information:machine.bindings.server.information,database:db,cors:new CorsPolicy(['http://allowed.invalid']),authorization:{issuer:'https://installation.invalid'}},machineControl:original,async release(){if(!db!.status.closed)await db!.close();}};},
   async createAdapter(){devices++;return {stops:machine.bindings.stops,output:machine.bindings.print.output,lifecycle:machine.bindings.print.lifecycle,async authorizePrintFile(){},async release(){}};}
  });
  const running=runProductHost(factory,abort.signal,a=>addresses.push(`http://127.0.0.1:${a.port}`),control,a=>{const secure=(a as AddressInfo&{secure?:AddressInfo}).secure;if(secure)secureBase=`https://127.0.0.1:${secure.port}/printer`;listening.resolve(`http://127.0.0.1:${a.port}`);});void running.catch(listening.reject);const base=await listening.promise+'/printer',key=await (await db!.wrapNamespace('native_authorization',false)).get('api_key') as string,headers={'x-api-key':key};
  const get=async(path:string)=>{const r=await fetch(base+path,{headers});assert.equal(r.status,200,await r.clone().text());return (await r.json() as any).result;};
  const post=(path:string,body:unknown={})=>fetch(base+path,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)});
  return {abort,control,base,secureBase,headers,get,post,running,factory,db:db!,async close(){abort.abort();try{await running;}finally{await factory.close!();}}};
 };
 return {f,machine,start,addresses,originalActions,get counts(){return {devices,processes};},async close(){await machine.close();await f.close();}};
}
test('actual authenticated HTTP install callback keeps device blocked, commits backup/version, afterResponse restarts and fresh process verifies without password',async()=>{
 const f=await fixture();let a:Awaited<ReturnType<typeof f.start>>|undefined,b:typeof a;try{
  a=await f.start();await until(()=>a!.control.status.restart_available);assert.equal(f.counts.devices,0);const sudo=await a.get('/machine/sudo/info');assert.equal(sudo.sudo_requested,true);assert.equal(sudo.sudo_access,null);
  const welcome=await fetch(a.base+'/');assert.equal(welcome.status,200);assert((await welcome.text()).includes('sudo'));const announcements=await a.get('/server/announcements/list');assert(announcements.entries.some((e:any)=>e.priority==='high'&&e.url==='/printer/'));
  const unauthorized=await fetch(a.base+'/machine/sudo/password',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'fixture-password'})});assert.equal(unauthorized.status,401);assert.deepEqual(f.f.commands,[]);
  const response=await a.post('/machine/sudo/password',{password:'fixture-password'});assert.equal(response.status,200,await response.clone().text());const receipt=(await response.json() as any).result;assert.equal(receipt.is_restarting,true);await until(()=>f.f.commands.some(c=>c.includes('restart')));assert.deepEqual(f.f.commands,[['daemon-reload'],['--no-block','restart','--','anyraid.service']]);assert.equal(f.counts.devices,0);assert.equal((await a.get('/server/info')).native_host.ready,false);assert.equal((await a.get('/server/announcements/list')).entries.some((e:any)=>e.title==='Node Installation Sudo Password Required'),false);assert.equal(await a.db.get('moonraker','validate_install.install_version'),0);
  await a.close();a=undefined;const probes=f.f.counts.privateProbes;b=await f.start();await until(()=>f.addresses.length===1);assert.equal(f.counts.devices,1);assert.equal(f.f.counts.privateProbes,probes,'new process must verify public attestation without sudo credentials/cache');assert.equal((await b.get('/machine/sudo/info')).sudo_requested,false);assert.equal((await b.get('/server/info')).native_host.ready,true);
  // Installation bridge must restore the trusted preexisting machine owner.
  const external=await b.post('/machine/services/start',{service:'camera.service'});assert.equal(external.status,200,await external.clone().text());await until(()=>f.originalActions.some(a=>a.kind==='service'));assert.deepEqual(f.originalActions[0],{kind:'service',action:'start',service:'camera.service'});await until(()=>!b!.control.status.busy);
  const restart=await b.post('/server/restart');assert.equal(restart.status,200,await restart.clone().text());await until(()=>f.originalActions.some(a=>a.kind==='server_restart'));assert.equal(f.f.commands.length,2,'ready machine actions must not be silently rerouted into installer sudo');
 }finally{try{await b?.close();}finally{try{await a?.close();}finally{await f.close();}}}
});
test('shutdown joins an in-flight installation before closing config/announcements/database and keeps unknown outcome',async()=>{
 const f=await fixture();let a:Awaited<ReturnType<typeof f.start>>|undefined;const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let finished=false;
 try{f.f.setEffect(async args=>{if(args[0]==='daemon-reload'){entered.resolve();await release.promise;}});a=await f.start();await until(()=>a!.control.status.restart_available);const request=a.post('/machine/sudo/password',{password:'fixture-password'});void request.catch(()=>{});await entered.promise;assert.equal(f.counts.devices,0);a.abort.abort();void a.running.then(()=>finished=true,()=>finished=true);await delay(30);assert.equal(finished,false);assert.equal(a.db.status.closed,false);assert.equal(JSON.parse(await readFile(f.f.options.recoveryPath,'utf8')).phase,'service-started');release.resolve();await assert.rejects(a.running);await request.catch(()=>{});assert.equal(a.db.status.closed,true);assert.equal(JSON.parse(await readFile(f.f.options.recoveryPath,'utf8')).phase,'service-started');assert.equal(f.f.commands.some(c=>c.includes('restart')),false);await assert.rejects(a.close());a=undefined;}finally{release.resolve();try{await a?.close().catch(()=>{});}finally{await f.close();}}
});
test('actual network closure failure is retained while installation and database resources still close',async()=>{
 const f=await fixture();let a:Awaited<ReturnType<typeof f.start>>|undefined;const original=MoonrakerNetwork.prototype.close;
 try{a=await f.start();await until(()=>a!.control.status.restart_available);MoonrakerNetwork.prototype.close=async function(){await original.call(this);throw Error('injected network closure failure');};a.abort.abort();await assert.rejects(a.running,/network|cleanup/i);assert.equal(a.db.status.closed,true);await assert.rejects(a.close());a=undefined;}finally{MoonrakerNetwork.prototype.close=original;try{await a?.close().catch(()=>{});}finally{await f.close();}}
});
test('DEFAULT password inherits privately across sections and every public snapshot; unauthorized CORS cannot probe sudo',async()=>{
 const f=await fixture();let a:Awaited<ReturnType<typeof f.start>>|undefined;const marker='synthetic-secret-do-not-publish';
 try{await writeFile(f.f.configFile,'[DEFAULT]\nsudo_password: '+marker+'\n'+f.f.original+'\n[machine]\n[extra_private_inheritance]\n');a=await f.start();await until(()=>a!.control.status.restart_available);const config=await a.get('/server/config');assert(!JSON.stringify(config).includes(marker));assert.equal(config.config.machine.sudo_password,'<redacted>');assert.equal(config.orig.server.sudo_password,'<redacted>');assert.equal(config.orig.extra_private_inheritance.sudo_password,'<redacted>');assert.equal(config.orig.DEFAULT.sudo_password,'<redacted>');
  const probes=f.f.counts.privateProbes,denied=await fetch(a.base+'/machine/sudo/info?check_access=true',{headers:{...a.headers,origin:'http://denied.invalid'}});assert.equal(denied.status,403);assert.equal(f.f.counts.privateProbes,probes);const allowed=await fetch(a.base+'/machine/sudo/info',{headers:{...a.headers,origin:'http://allowed.invalid'}});assert.equal(allowed.status,200);assert.equal(allowed.headers.get('access-control-allow-origin'),'http://allowed.invalid');
  const post=await a.post('/machine/sudo/password',{password:'fixture-password'});assert.equal(post.status,200,await post.clone().text());await until(()=>f.f.commands.length===2);assert(!JSON.stringify(await a.get('/server/config')).includes(marker));assert(!JSON.stringify(await a.get('/machine/sudo/info')).includes(marker));assert(!JSON.stringify(await a.get('/server/announcements/list')).includes(marker));assert(!JSON.stringify(await readFile(f.f.options.recoveryPath,'utf8')).includes(marker));
 }finally{try{await a?.close();}finally{await f.close();}}
});
test('DEFAULT sudo password inherited into authorization retains the original strict unsupported-option rejection',async()=>{
 const f=await fixedInstallFixture();try{await writeFile(f.configFile,'[DEFAULT]\nsudo_password: synthetic-private\n'+f.original+'\n[authorization]\n');const reader=new ConfigurationReader(await loadConfiguration(f.configFile));assert.throws(()=>readAuthorizationOptions(reader,'https://installation.invalid'),/Unsupported \[authorization\] option 'sudo_password'/);assert.equal(f.counts.privateProbes,0);}finally{await f.close();}
});
async function httpsWire(url:string,ca:string,headers:Record<string,string>,body?:string){return new Promise<{status:number;body:string}>((resolveResult,reject)=>{const req=httpsRequest(url,{ca,agent:false,method:body?'POST':'GET',headers:{...headers,...body?{'content-type':'application/json','content-length':String(Buffer.byteLength(body))}:{}}},res=>{const parts:Buffer[]=[];res.on('data',(b:Buffer)=>parts.push(b));res.on('end',()=>resolveResult({status:res.statusCode!,body:Buffer.concat(parts).toString()}));res.on('error',reject);});req.setTimeout(5000,()=>req.destroy(Error('TLS fixture deadline')));req.on('error',reject);req.end(body);});}
test('actual HTTPS password install and fresh process retain standard TLS/secrets fallback after equal legacy paths are removed',async()=>{
 const f=await fixture(),identity=await mqttCertificate();let a:Awaited<ReturnType<typeof f.start>>|undefined,b:typeof a;try{
  const certs=join(f.f.dataPath,'certs');await mkdir(certs,{mode:0o700});const cert=join(certs,'moonraker.cert'),key=join(certs,'moonraker.key');await writeFile(cert,identity.cert);await writeFile(key,identity.key,{mode:0o600});await writeFile(f.f.configFile,f.f.original.replace('[database]',`  ssl_port:0\n  ssl_certificate_path:${cert}\n  ssl_key_path:${key}\n[database]`));
  a=await f.start();await until(()=>a!.control.status.restart_available);assert(a.secureBase);const welcome=await httpsWire(a.secureBase+'/',identity.cert,{});assert.equal(welcome.status,200);const post=await httpsWire(a.secureBase+'/machine/sudo/password',identity.cert,a.headers,JSON.stringify({password:'fixture-password'}));assert.equal(post.status,200,post.body);await until(()=>f.f.commands.length===2);const after=await readFile(f.f.configFile,'utf8');assert(!after.includes('ssl_certificate_path'));assert(!after.includes('ssl_key_path'));assert(!after.includes('secrets_path'));await a.close();a=undefined;
  const probes=f.f.counts.privateProbes;b=await f.start();await until(()=>f.addresses.length===1);assert(b.secureBase);const info=await httpsWire(b.secureBase+'/server/info',identity.cert,b.headers);assert.equal(info.status,200);assert.equal(JSON.parse(info.body).result.native_host.ready,true);assert.equal(f.f.counts.privateProbes,probes);assert.equal((await httpsWire(b.secureBase+'/',identity.cert,{})).status,200);
 }finally{try{await b?.close();}finally{try{await a?.close();}finally{await f.close();}}}
});
