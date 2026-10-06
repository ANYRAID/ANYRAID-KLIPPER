import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {LinuxMachineControl} from '../src/moonraker/machine-control.ts';
import {createNativeProductHostFactory} from '../src/runtime/native-product-machine.ts';
import {runProductHost} from '../src/runtime/product-host.ts';
import {ProductHostControl} from '../src/runtime/product-host-control.ts';
import {productMachineFixture} from './helpers/product-machine.ts';
async function until(check:()=>boolean){const end=performance.now()+10000;while(!check()){assert(performance.now()<end,'Machine host timeout');await delay(5);}}
async function fixture(options:{holdStop?:boolean;failStop?:boolean;failCommand?:boolean}={}){
 const root=await mkdtemp(join(tmpdir(),'native-machine-control-')),f=await productMachineFixture(root),abort=new AbortController(),control=new ProductHostControl(),ready=Promise.withResolvers<string>(),held=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();
 const own='anyraid-node-product-host.service',commands:string[][]=[];let db:DatabaseStore|undefined,key='',releases=0,generations=0,terminal=false,deviceState='inactive',devicePid='0';
 const machine=new LinuxMachineControl({ownUnit:own,allowedUnits:['crowsnest.service','klipper-2.service']},{readCgroup:async()=> '0::/system.slice/'+own,insideContainer:async()=>false,command:async args=>{
  if(args.includes('show'))return 'Id='+args.at(-1)+'\nLoadState=loaded\n'+(args.includes('--property=Id,LoadState,ActiveState,MainPID')?'ActiveState='+deviceState+'\nMainPID='+devicePid+'\n':'');
  commands.push([...args]);if(args.at(-1)!=='crowsnest.service'){assert(f.transport.stops.every(n=>n>=1));assert.equal(releases,1,'System action must follow dependency release');}
  if(options.failCommand)throw Error('Permission denied');if(args.at(-1)==='klipper-2.service'){deviceState=args.includes('stop')?'inactive':'active';devicePid=deviceState==='active'?'123':'0';}return '';
 }});
 const native=createNativeProductHostFactory(f.path,{filesRoot:join(root,'files'),metadataRoot:join(root,'metadata'),
  async createProcess(){db=await DatabaseStore.open({path:join(root,'api.db')});return {machineControl:machine,server:{information:f.bindings.server.information,database:db,authorization:{issuer:'https://machine.invalid'}},async release(){await db!.close();}};},
  async createAdapter(){generations++;return {stops:new Map([...f.bindings.stops].map(([id,stop])=>[id,async(cause:unknown)=>{await stop(cause);if(id==='mcu'){entered.resolve();if(options.holdStop)await held.promise;if(options.failStop)throw Error('Physical stop unconfirmed');}}])),output:f.bindings.print.output,lifecycle:f.bindings.print.lifecycle,async authorizePrintFile(){},async release(){releases++;}};}
 });
 const running=runProductHost(native,abort.signal,a=>ready.resolve('http://127.0.0.1:'+a.port),control);void running.then(()=>{terminal=true;},e=>{terminal=true;ready.reject(e);});
 const base=await ready.promise;key=await (await db!.wrapNamespace('native_authorization',false)).get('api_key') as string;
 const invoke=async(path:string,body:Record<string,string>={})=>{const res=await fetch(base+path,{method:'POST',headers:{'x-api-key':key,'content-type':'application/json'},body:JSON.stringify(body)});return {status:res.status,body:await res.json() as any};};
 const get=async(path:string)=>{const res=await fetch(base+path,{headers:{'x-api-key':key}});assert.equal(res.status,200);return (await res.json() as any).result;};
 return {root,f,abort,control,commands,held,entered:entered.promise,running,invoke,get,get releases(){return releases;},get generations(){return generations;},get terminal(){return terminal;},async close(){held.resolve();abort.abort();await running.catch(()=>{});await native.close!().catch(()=>{});await machine.close();await f.close();await rm(root,{recursive:true,force:true});}};
}
for(const [path,kind,body] of [['/server/restart','server_restart',{}],['/machine/reboot','machine_reboot',{}],['/machine/shutdown','machine_shutdown',{}],['/machine/services/restart','service_restart',{service:'anyraid-node-product-host'}]] as const)test(`${path} waits for actual device retirement and resolves its receipt without awaiting its own process exit`,async t=>{
 const f=await fixture({holdStop:true});try{
  const reply=await f.invoke(path,body);assert.equal(reply.status,200);assert.equal(reply.body.result,'ok');await f.entered;
  assert.equal(f.commands.length,0);assert.equal(f.releases,0);assert.equal(f.control.status.machine_control.operations.find(r=>r.kind===kind)?.state,'running');
  f.held.resolve();await until(()=>f.control.status.machine_control.operations.find(r=>r.kind===kind)?.state==='succeeded');assert.equal(f.commands.length,1);assert.equal(f.terminal,false);assert.equal(f.generations,1);assert.equal((await f.get('/server/info')).native_host.ready,false);await f.get('/server/files/list');
  f.abort.abort();await f.running;assert.equal(f.terminal,true);t.diagnostic('Actual product loop and durable receipt, two PTY MCU stop callbacks and dependency release precede injected OS submission. No actual OS or physical printer operation.');
 }finally{await f.close();}
});
test('unconfirmed native device stop rejects the accepted operation without submitting any OS command',async()=>{
 const f=await fixture({failStop:true});try{assert.equal((await f.invoke('/machine/shutdown')).status,200);await until(()=>f.control.status.machine_control.operations.find(r=>r.kind==='machine_shutdown')?.state==='failed');assert.equal(f.commands.length,0);assert.equal(f.control.status.machine_control.available_kinds.length,0);assert.equal(f.generations,1);assert.equal((await f.get('/server/info')).native_host.ready,false);f.abort.abort();await assert.rejects(f.running,/stop|cleanup/);}finally{await f.close();}
});
test('external service actions preserve ready hardware while a foreign Klipper owner prevents reacquisition',async()=>{
 const f=await fixture();try{
  assert.equal((await f.invoke('/machine/services/start',{service:'crowsnest'})).status,200);await until(()=>!f.control.status.busy);assert.equal(f.releases,0);assert(f.f.transport.stops.every(n=>n===0));assert.equal((await f.get('/server/info')).native_host.ready,true);
  assert.equal((await f.invoke('/machine/services/start',{service:'klipper-2'})).status,200);await until(()=>!f.control.status.busy);assert.equal(f.releases,1);assert.equal(f.generations,1);
  assert.equal((await f.invoke('/printer/restart')).status,200);await until(()=>f.control.status.restart_operation?.state==='failed');assert.equal(f.generations,1,'Accepted service start must not permit a competing native device owner');
  assert.equal((await f.invoke('/machine/services/stop',{service:'klipper-2'})).status,200);await until(()=>!f.control.status.busy);assert.equal((await f.invoke('/printer/restart')).status,200);await until(()=>f.control.status.restart_operation?.state==='succeeded');assert.equal(f.generations,2);assert.equal((await f.get('/server/info')).native_host.ready,true);f.abort.abort();await f.running;
 }finally{await f.close();}
});
test('OS command permission failure remains queryable and does not reopen hardware automatically',async()=>{
 const f=await fixture({failCommand:true});try{assert.equal((await f.invoke('/server/restart')).status,200);await until(()=>f.control.status.machine_control.operations.find(r=>r.kind==='server_restart')?.state==='failed');assert.equal(f.commands.length,1);assert.equal(f.generations,1);assert.equal(f.terminal,false);assert.equal((await f.get('/server/info')).native_host.ready,false);await f.get('/server/files/list');f.abort.abort();await assert.rejects(f.running,/Permission/);}finally{await f.close();}
});
