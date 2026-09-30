import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {spawn,execFileSync,type ChildProcess} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,writeFile,readFile,readdir,readlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import WebSocket from 'ws';
import {buildProductHost} from '../scripts/build-product-host.ts';
import {installProductDependencies} from '../test/helpers/product-install.ts';
import {productMachineFixture} from '../test/helpers/product-machine.ts';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {ApiKeyAuthorization} from '../src/moonraker/api-key-authorization.ts';
import {recoveryJournalV1} from '../test/helpers/recovery-journal-v1.ts';
test('compiled bootstrap and standard RESTART preserve same MCU config, socket and resources across explicit failure recovery',async t=>{
 const root=await mkdtemp(join(tmpdir(),'compiled-restart-')),app=join(root,'app'),f=await productMachineFixture(root),auth=join(root,'api.db'),trace=join(root,'trace.jsonl'),module=join(root,'machine.mjs');
 let child:ChildProcess|undefined,socket:WebSocket|undefined,ended:Promise<unknown>|undefined;let stderr='',output='';const ready:string[]=[],listening:string[]=[],events:any[]=[],fds:number[]=[],times:number[]=[],latencies:number[]=[],fdSamples:{total:number;persistent:number;sockets:number;targets:string[]}[]=[];
 try{
  await buildProductHost(app);t.diagnostic(JSON.stringify({installation:await installProductDependencies(app)}));
  const recoveryPath=f.config.journalPath+'.host-recovery.sqlite';
  recoveryJournalV1(recoveryPath,f.config.deviceId,Array.from({length:128},(_,i)=>({request_id:i===0?'restart-legacy-owned':'controlled-'+i,state_token:'original-token',state:'succeeded',error:null})));
  // The emitted JS worker migrates a full v1 history and fills the separate
  // standard ring. The actual host then crosses that persisted boundary.
  const journalModule=JSON.stringify(pathToFileURL(join(app,'host/src/runtime/host-recovery-journal.js')).href);
  execFileSync(process.execPath,['--no-experimental-strip-types','--input-type=module','-e',`import {HostRecoveryJournal} from ${journalModule};const {journal}=await HostRecoveryJournal.open({path:${JSON.stringify(recoveryPath)},deviceId:'printer'});try{for(let i=0;i<64;i++){const r={request_id:'restart-seeded-'+i,state_token:'original-token',kind:'restart',state:'queued',error:null};await journal.save(r);await journal.save({...r,state:'running'});await journal.save({...r,state:'succeeded'});}}finally{await journal.close();}`],{env:{...process.env,PATH:'/no-programs',NODE_OPTIONS:'--no-experimental-strip-types',NODE_PATH:''},timeout:15000,stdio:'pipe'});
  const db=await DatabaseStore.open({path:auth});let key:string;try{const owner=await ApiKeyAuthorization.open(db,{issuer:'https://compiled-restart.invalid'});try{key=owner.localApiKey();}finally{await owner.close();}}finally{await db.close();}
  const source=(path:string)=>JSON.stringify(pathToFileURL(join(app,path)).href);
  await writeFile(module,`import {appendFile} from 'node:fs/promises';
import {createNativeProductHostFactory} from ${source('host/src/runtime/native-product-machine.js')};
import {DatabaseStore} from ${source('host/src/moonraker/database.js')};
const record=event=>appendFile(${JSON.stringify(trace)},JSON.stringify(event)+'\\n');
export const createProductHostProfile=createNativeProductHostFactory(${JSON.stringify(f.path)},{filesRoot:${JSON.stringify(join(root,'files'))},metadataRoot:${JSON.stringify(join(root,'metadata'))},standardPrint:{nozzle:0,bed:0},
async createProcess(){const database=await DatabaseStore.open({path:${JSON.stringify(auth)}});await record({event:'process-open'});return {server:{information:${JSON.stringify(f.bindings.server.information)},database,authorization:{issuer:'https://compiled-restart.invalid'}},async release(){if(!database.status.closed)await database.close();await record({event:'process-closed'});}};},
async createAdapter(_c,_s,_g,_p,reload){await record({event:'adapter',reason:reload.reason});return {stops:new Map(['mcu','aux'].map(id=>[id,async()=>record({event:'stop',id})])),output:()=>{},lifecycle:{prepare:async()=>{},start:async()=>{},finishOutputs:async()=>{},stopOutputs:async()=>{}},authorizePrintFile:async()=>{},release:async()=>record({event:'released'})};}});
`);
  const configuration=await readFile(f.config.printerConfig,'utf8');await writeFile(f.config.printerConfig,'[printer]\nkinematics: invalid\n');
  child=spawn(process.execPath,['--no-experimental-strip-types',join(app,'scripts/product-host.js'),'--profile',module],{cwd:root,env:{...process.env,PATH:'/no-programs',NODE_OPTIONS:'--no-experimental-strip-types',NODE_PATH:''},stdio:['ignore','pipe','pipe']});
  ended=once(child,'exit').then(([code,signal])=>({code,signal}));child.stdout!.on('data',chunk=>{output+=chunk.toString();for(const line of output.split('\n').slice(0,-1)){const entry=JSON.parse(line);if(entry.event==='listening')listening.push(`http://127.0.0.1:${entry.address.port}`);if(entry.event==='ready')ready.push(`http://127.0.0.1:${entry.address.port}`);}output=output.slice(output.lastIndexOf('\n')+1);});child.stderr!.on('data',chunk=>{stderr+=chunk.toString();});
  const until=async(check:()=>boolean)=>{const end=performance.now()+10000;while(!check()){assert(child!.exitCode===null&&child!.signalCode===null,stderr);assert(performance.now()<end,'compiled restart timeout: '+stderr);await delay(5);}};
  await until(()=>listening.length===1);const base=listening[0],headers={'x-api-key':key!},get=async(path:string)=>{const start=performance.now(),response=await fetch(base+path,{headers,signal:AbortSignal.timeout(5000)});assert.equal(response.status,200,path);const value=(await response.json() as any).result;latencies.push(performance.now()-start);return value;};
  const initialHistory=await get('/printer/host/status');assert.equal(initialHistory.restart_operation.request_id,'restart-seeded-63');assert.deepEqual(initialHistory.recovery_history,{controlled:{retained:128,capacity:128},standard_restart:{retained:64,capacity:64}});
  socket=new WebSocket(base.replace('http:','ws:')+'/websocket',{headers});socket.on('message',data=>events.push(JSON.parse(data.toString())));await once(socket,'open');socket.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'server.connection.identify',params:{client_name:'restart-acceptance',version:'1',type:'web',url:'https://compiled-restart.invalid'}}));await until(()=>events.some(e=>e.id===1));const connection=events.find(e=>e.id===1).result.connection_id;
  const form=new FormData();form.append('file',new Blob(['; layer_height = 0.2\nG1 X1\n']),'retained.gcode');form.append('file_id','retained');const uploaded=await fetch(base+'/server/files/upload',{method:'POST',headers,body:form});assert.equal(uploaded.status,200);assert.equal((await uploaded.json() as any).result.print_started,false);
  assert.equal(ready.length,0);assert(f.transport.firmware.every(m=>m.stepperConfigs.length===0));const disconnected=await get('/server/info');assert.equal(disconnected.native_host.ready,false);assert.equal(disconnected.native_host.startup_failure,'device_startup_failed');assert.equal(disconnected.klippy_connected,false);assert.equal((await get('/printer/info')).python_path,'');assert.equal((await fetch(base+'/server/info')).status,401);await get('/server/files/metadata?filename=retained.gcode');await get('/server/history/list');assert(!events.some(e=>e.method==='notify_klippy_ready'));assert.equal((await fetch(base+'/printer/print/start',{method:'POST',headers:{...headers,'content-type':'application/json'},body:'{"filename":"retained.gcode"}'})).status,503);
  const receipt=async(state:string)=>{let value:any;for(let i=0;i<2000;i++){value=await get('/printer/host/status');if(value.restart_operation?.state===state&&!value.busy)return value;await delay(5);}assert.fail(JSON.stringify(value));};
  const restart=async()=>{const result=await fetch(base+'/printer/restart',{method:'POST',headers});assert.equal(result.status,200);assert.equal((await result.json() as any).result,'ok');};
  const startup=performance.now();await writeFile(f.config.printerConfig,configuration);socket.send(JSON.stringify({jsonrpc:'2.0',id:100,method:'printer.restart'}));await until(()=>events.some(e=>e.id===100));assert.equal(events.find(e=>e.id===100).result,'ok');await receipt('succeeded');await until(()=>ready.length===1);const bootstrapRecoveryMs=performance.now()-startup,counts=f.transport.firmware.map(m=>m.stepperConfigs.length);assert(counts.some(n=>n>0));
  for(let generation=1;generation<=4;generation++){
   if(generation>1){const start=performance.now();await restart();await receipt('succeeded');times.push(performance.now()-start);}
   assert.equal(ready.length,generation);assert(ready.every(value=>value===base));assert.equal((await get('/server/info')).native_host.ready,true);assert.deepEqual(f.transport.firmware.map(m=>m.stepperConfigs.length),counts);assert.equal(socket.readyState,WebSocket.OPEN);assert.equal(await (await fetch(base+'/server/files/gcodes/retained.gcode',{headers})).text(),'; layer_height = 0.2\nG1 X1\n');
   socket.send(JSON.stringify({jsonrpc:'2.0',id:generation+1,method:'server.websocket.id'}));await until(()=>events.some(e=>e.id===generation+1));assert.equal(events.find(e=>e.id===generation+1).result.websocket_id,connection);
   await Promise.all(Array.from({length:4},async()=>{for(let i=0;i<100;i++)await get(i%2?'/server/history/list':'/server/files/list');}));
   const entries=await Promise.all((await readdir('/proc/'+child.pid+'/fd')).map(async fd=>{try{return await readlink('/proc/'+child!.pid+'/fd/'+fd);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}})),targets=entries.filter((value):value is string=>value!==undefined).map(value=>value.replace(root,'<fixture>')).sort(),sockets=targets.filter(value=>value.startsWith('socket:')).length;
   fds.push(targets.length);fdSamples.push({total:targets.length,persistent:targets.length-sockets,sockets,targets});
   assert.deepEqual((await get('/printer/host/status')).recovery_history,initialHistory.recovery_history);
  }
  await writeFile(f.config.printerConfig,'[printer]\nkinematics: invalid\n');await restart();const failed=await receipt('failed');assert.equal(failed.restart_available,true);assert.equal((await get('/server/info')).native_host.ready,false);await get('/server/files/metadata?filename=retained.gcode');await get('/server/history/list');
  await delay(30);assert.equal(ready.length,4);await writeFile(f.config.printerConfig,configuration);socket.send(JSON.stringify({jsonrpc:'2.0',id:20,method:'printer.restart'}));await until(()=>events.some(e=>e.id===20));assert.equal(events.find(e=>e.id===20).result,'ok');await receipt('succeeded');assert.equal(ready.length,5);assert.equal((await get('/printer/host/status?request_id='+failed.restart_operation.request_id)).operation.state,'failed');assert.deepEqual(f.transport.firmware.map(m=>m.stepperConfigs.length),counts);
  assert.equal((await get('/printer/host/status?request_id=restart-seeded-0')).operation,null);assert.equal((await get('/printer/host/status?request_id=restart-seeded-6')).operation.state,'succeeded');assert.equal((await get('/printer/host/status?request_id=restart-legacy-owned')).operation.state,'succeeded');
  assert(events.some(e=>e.method==='notify_klippy_disconnected'));assert(events.some(e=>e.method==='notify_klippy_ready'));assert.equal(f.transport.firmware.flatMap(m=>m.outputs).filter(o=>o.name==='reset').length,0);assert.equal(f.transport.firmware.flatMap(m=>m.motion).length,0);
  // EXCLUSIVE SQLite opens/caches its rollback-journal descriptor on the first
  // write. Account for that specific lazy resource, then require all other
  // persistent descriptors stable; no growing client/IPC socket population.
  const cachedJournal=(recoveryPath+'-journal').replace(root,'<fixture>'),cachedJournalCounts=fdSamples.map(sample=>sample.targets.filter(value=>value===cachedJournal).length);
  assert(cachedJournalCounts.every((count,index)=>index===0?count<=1:count===1),JSON.stringify({fdSamples}));
  const steady=fdSamples.map((sample,index)=>sample.persistent-cachedJournalCounts[index]);assert.equal(Math.max(...steady)-Math.min(...steady),0,JSON.stringify({fdSamples}));
  assert(fdSamples.every(sample=>sample.sockets<=fdSamples[0].sockets),JSON.stringify({fdSamples}));
  const canonical=[f.config.journalPath,recoveryPath,auth,...f.transport.firmware.map(m=>m.path)].map(path=>path.replace(root,'<fixture>'));
  for(const path of canonical)assert(fdSamples.every(sample=>sample.targets.filter(value=>value===path).length===1),JSON.stringify({path,fdSamples}));
  child.kill('SIGTERM');assert.deepEqual(await ended,{code:0,signal:null});ended=undefined;
  const records=(await readFile(trace,'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(records.filter(e=>e.event==='process-open').length,1);assert.equal(records.filter(e=>e.event==='process-closed').length,1);assert.equal(records.filter(e=>e.event==='released').length,5);assert.equal(records.filter(e=>e.event==='stop').length,10);
  const sorted=latencies.toSorted((a,b)=>a-b),p99=sorted[Math.ceil(sorted.length*.99)-1];assert(p99<20,JSON.stringify({p99,queries:sorted.length}));t.diagnostic(JSON.stringify({bundleSha256:createHash('sha256').update(await readFile(join(app,'build-info.json'))).digest('hex'),queries:sorted.length,queryP99Ms:p99,restartMs:times,readyFileDescriptors:fds,descriptorSamples:fdSamples.map(({targets,...counts},i)=>({...counts,cachedJournal:cachedJournalCounts[i],steadyPersistent:steady[i]})),canonicalDeviceAndDatabaseDescriptors:canonical.length,sameMCUFirmware:true,stepperConfigurations:counts,recoveryHistory:initialHistory.recovery_history,compiledV1Migration:true,initialConfigurationFailureRecovered:true,bootstrapListeners:listening.length,bootstrapRecoveryMs,expiredStandardIDsAbsent:true,hardwareAcceptance:false}));
 }finally{socket?.terminate();if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await ended;await f.close();await rm(root,{recursive:true,force:true});}
});
