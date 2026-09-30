import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {spawn,type ChildProcess} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,rm,writeFile,readFile,readdir,readlink} from 'node:fs/promises';
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

for(const firmwareRestart of [false,true])test(firmwareRestart?'compiled FIRMWARE_RESTART clears original MCU CRC/shutdown and rebuilds twice without Python':'compiled ordinary RESTART cannot reset or cure CRC drift and latched shutdown on either MCU',async t=>{
 const root=await mkdtemp(join(tmpdir(),'compiled-restart-fault-')),app=join(root,'app'),latencies:number[]=[],results:Record<string,unknown>[]=[];
 try{
  await buildProductHost(app);t.diagnostic(JSON.stringify({installation:await installProductDependencies(app)}));
  for(const fault of ['crc','shutdown'] as const)for(const index of [0,1]){
   const dir=join(root,fault+'-'+index);await mkdir(dir);const f=await productMachineFixture(dir,false,'ack'),databasePath=join(dir,'api.db'),trace=join(dir,'trace.jsonl'),profile=join(dir,'machine.mjs');
   let child:ChildProcess|undefined,socket:WebSocket|undefined,ended:Promise<{code:number|null;signal:NodeJS.Signals|null}>|undefined;let stderr='',output='';const addresses:string[]=[],listening:string[]=[],events:any[]=[];
   try{
    const db=await DatabaseStore.open({path:databasePath});let key:string;try{const auth=await ApiKeyAuthorization.open(db,{issuer:'https://compiled-fault.invalid'});try{key=auth.localApiKey();}finally{await auth.close();}}finally{await db.close();}
    const source=(path:string)=>JSON.stringify(pathToFileURL(join(app,path)).href);
    await writeFile(profile,`import {appendFile} from 'node:fs/promises';
import {createNativeProductHostFactory} from ${source('host/src/runtime/native-product-machine.js')};
import {DatabaseStore} from ${source('host/src/moonraker/database.js')};
const record=value=>appendFile(${JSON.stringify(trace)},JSON.stringify(value)+'\\n');
export const createProductHostProfile=createNativeProductHostFactory(${JSON.stringify(f.path)},{filesRoot:${JSON.stringify(join(dir,'files'))},metadataRoot:${JSON.stringify(join(dir,'metadata'))},standardPrint:{nozzle:0,bed:0},
async createProcess(){const database=await DatabaseStore.open({path:${JSON.stringify(databasePath)}});await record({event:'process-open'});return {server:{information:${JSON.stringify(f.bindings.server.information)},database,authorization:{issuer:'https://compiled-fault.invalid'}},async release(){if(!database.status.closed)await database.close();await record({event:'process-closed'});}};},
async createAdapter(_c,_s,_g,_p,reload){await record({event:'adapter',reason:reload.reason});return {stops:new Map(['mcu','aux'].map(id=>[id,async()=>record({event:'stop',id})])),output:()=>{},lifecycle:{prepare:async()=>{},start:async()=>{},finishOutputs:async()=>{},stopOutputs:async()=>{}},authorizePrintFile:async()=>{},release:async()=>record({event:'released'})};}});
`);
    child=spawn(process.execPath,['--no-experimental-strip-types',join(app,'scripts/product-host.js'),'--profile',profile],{cwd:dir,env:{...process.env,PATH:'/no-programs',NODE_OPTIONS:'--no-experimental-strip-types',NODE_PATH:''},stdio:['ignore','pipe','pipe']});
    ended=once(child,'exit').then(([code,signal])=>({code,signal}));child.stderr!.on('data',bytes=>stderr+=bytes.toString());child.stdout!.on('data',bytes=>{output+=bytes.toString();for(const line of output.split('\n').slice(0,-1)){const entry=JSON.parse(line);if(entry.event==='ready')addresses.push(`http://127.0.0.1:${entry.address.port}`);if(entry.event==='listening')listening.push(`http://127.0.0.1:${entry.address.port}`);}output=output.slice(output.lastIndexOf('\n')+1);});
    const until=async(check:()=>boolean)=>{const end=performance.now()+10000;while(!check()){assert(child!.exitCode===null&&child!.signalCode===null,stderr);assert(performance.now()<end,'Compiled fault timeout');await delay(5);}};
    await until(()=>addresses.length===1);const base=addresses[0],headers={'x-api-key':key!};
    const get=async(path:string)=>{const start=performance.now(),response=await fetch(base+path,{headers,signal:AbortSignal.timeout(5000)});assert.equal(response.status,200,path);const value=(await response.json() as any).result;latencies.push(performance.now()-start);return value;};
    const receipt=async(state:string,firmware=false)=>{const end=performance.now()+10000;while(performance.now()<end){const status=await get('/printer/host/status');if(status[firmware?'firmware_restart_operation':'restart_operation']?.state===state&&!status.busy)return status;await delay(5);}assert.fail('Missing terminal restart receipt');};
    const form=new FormData();form.append('file',new Blob(['G1 X1\n']),'retained.gcode');form.append('file_id','retained');const upload=await fetch(base+'/server/files/upload',{method:'POST',headers,body:form});assert.equal(upload.status,200);assert.equal((await upload.json() as any).result.print_started,false);
    socket=new WebSocket(base.replace('http:','ws:')+'/websocket',{headers});socket.on('message',bytes=>events.push(JSON.parse(bytes.toString())));await once(socket,'open');socket.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'server.connection.identify',params:{client_name:'fault-acceptance',version:'1',type:'web',url:'https://compiled-fault.invalid'}}));await until(()=>events.some(e=>e.id===1));const connection=events.find(e=>e.id===1).result.connection_id;
    const firmware=f.transport.firmware,original=firmware.map(m=>m.configuration),traffic=firmware.map(m=>m.configurationTraffic),counts=firmware.map(m=>m.stepperConfigs.length),config=await readFile(f.config.printerConfig,'utf8');assert(firmware.every(m=>m.dictionary.commandFormats.includes('reset')));
    if(fault==='crc'){const changed=config.replace(index===0?'step_pin: STEP':'pin: aux:PA0',index===0?'step_pin: !STEP':'pin: !aux:PA0');assert.notEqual(changed,config);await writeFile(f.config.printerConfig,changed);}else{firmware[index].emit('shutdown',{clock:firmware[index].currentClock()>>>0,static_string_id:'Timer too close'});await until(()=>events.some(e=>e.method==='notify_klippy_shutdown'));assert.equal((await get('/server/info')).native_host.ready,false);}
    const failureIDs:string[]=[],readyPersistentDescriptors:number[]=[];
    const descriptors=async()=>{const names=await readdir('/proc/'+child!.pid+'/fd'),targets=await Promise.all(names.map(name=>readlink('/proc/'+child!.pid+'/fd/'+name).catch(()=>null)));assert(targets.every(value=>value!==null),'Descriptor disappeared during ready sample');return targets.filter(value=>!value!.startsWith('socket:')&&value!==f.config.journalPath).length;};
    for(let attempt=0;attempt<2;attempt++){
     if(attempt===0){const response=await fetch(base+'/printer/restart',{method:'POST',headers});assert.equal(response.status,200);assert.equal((await response.json() as any).result,'ok');}else{socket.send(JSON.stringify({jsonrpc:'2.0',id:2,method:'printer.restart'}));await until(()=>events.some(e=>e.id===2));assert.equal(events.find(e=>e.id===2).result,'ok');}
     const failed=await receipt('failed');failureIDs.push(failed.restart_operation.request_id);assert.equal(failed.restart_available,true);assert.equal(addresses.length,1);const host=(await get('/server/info')).native_host;assert.equal(host.ready,false);assert.equal(host.startup_failure,fault==='crc'?'mcu_configuration_mismatch':'mcu_shutdown');assert.equal(host.firmware_restart_required,true);assert.equal(host.hardware_state,'stopped');assert(!events.some(e=>e.method==='notify_klippy_ready'));assert.equal(socket.readyState,WebSocket.OPEN);
     assert.deepEqual(firmware.map(m=>m.configuration.crc),original.map(m=>m.crc));assert.deepEqual(firmware.map(m=>m.configurationTraffic.writes),traffic.map(m=>m.writes));assert.deepEqual(firmware.map(m=>m.configurationTraffic.finalizations),traffic.map(m=>m.finalizations));assert(firmware.every(m=>m.configurationTraffic.resets===0));assert.equal(firmware[index].configuration.shutdown,fault==='shutdown');
     assert.equal((await get('/server/files/list')).length,1);await get('/server/files/metadata?filename=retained.gcode');assert.equal((await get('/server/history/list')).count,0);assert.equal(await (await fetch(base+'/server/files/gcodes/retained.gcode',{headers})).text(),'G1 X1\n');const unauthorized=await fetch(base+'/server/info');assert.equal(unauthorized.status,401);await unauthorized.arrayBuffer();const print=await fetch(base+'/printer/print/start',{method:'POST',headers:{...headers,'content-type':'application/json'},body:'{"filename":"retained.gcode"}'});assert.equal(print.status,503);await print.arrayBuffer();
     socket.send(JSON.stringify({jsonrpc:'2.0',id:10+attempt,method:'server.websocket.id'}));await until(()=>events.some(e=>e.id===10+attempt));assert.equal(events.find(e=>e.id===10+attempt).result.websocket_id,connection);
    }
    assert.notEqual(failureIDs[0],failureIDs[1]);for(const id of failureIDs)assert.equal((await get('/printer/host/status?request_id='+id)).operation.state,'failed');
    if(firmwareRestart){
     const receipts:string[]=[];for(let attempt=0;attempt<2;attempt++){
      if(!attempt){const response=await fetch(base+'/printer/firmware_restart',{method:'POST',headers});assert.equal(response.status,200);await response.arrayBuffer();}else{socket.send(JSON.stringify({jsonrpc:'2.0',id:3,method:'printer.firmware_restart'}));await until(()=>events.some(e=>e.id===3));assert.equal(events.find(e=>e.id===3).result,'ok');}
      const settled=await receipt('succeeded',true);receipts.push(settled.firmware_restart_operation.request_id);await until(()=>addresses.length===attempt+2);const host=(await get('/server/info')).native_host;assert.equal(host.ready,true);assert.equal(host.homed_axes,'');assert.equal(host.firmware_restart_required,undefined);assert.equal(socket.readyState,WebSocket.OPEN);for(let i=0;i<2;i++){assert.equal(firmware[i].configuration.shutdown,false);assert.equal(firmware[i].configurationTraffic.resets,attempt+1);assert.equal(firmware[i].configurationTraffic.finalizations,traffic[i].finalizations+attempt+1);assert.equal(firmware[i].configuration.crc===original[i].crc,fault!=='crc'||i!==index);assert.equal(firmware[i].stepperConfigs.length,counts[i]*(attempt+2));}assert.equal(firmware.flatMap(m=>m.motion).length,0);readyPersistentDescriptors.push(await descriptors());
     }assert.equal(readyPersistentDescriptors[0],readyPersistentDescriptors[1]);assert.notEqual(receipts[0],receipts[1]);assert.equal(events.filter(e=>e.method==='notify_klippy_ready').length,2);
    }else if(fault==='crc'){await writeFile(f.config.printerConfig,config);const response=await fetch(base+'/printer/restart',{method:'POST',headers});assert.equal(response.status,200);await response.arrayBuffer();await receipt('succeeded');await until(()=>addresses.length===2);const host=(await get('/server/info')).native_host;assert.equal(host.ready,true);assert.equal(host.firmware_restart_required,undefined);assert.deepEqual(firmware.map(m=>m.configuration),original);assert.deepEqual(firmware.map(m=>m.stepperConfigs.length),counts);assert(firmware.every(m=>m.configurationTraffic.resets===0));}
    assert.equal(listening.length,1);assert(addresses.every(address=>address===base));child.kill('SIGTERM');assert.deepEqual(await ended,{code:firmwareRestart||fault==='crc'?0:1,signal:null});ended=undefined;
    const records=(await readFile(trace,'utf8')).trim().split('\n').map(line=>JSON.parse(line)),adapters=firmwareRestart?5:fault==='crc'?4:3;assert.equal(records.filter(e=>e.event==='adapter').length,adapters);assert.equal(records.filter(e=>e.event==='released').length,adapters);assert.equal(records.filter(e=>e.event==='stop').length,adapters*2+(firmwareRestart?12:0));assert.equal(records.filter(e=>e.event==='process-open').length,1);assert.equal(records.filter(e=>e.event==='process-closed').length,1);
    results.push({firmwareRestart,fault,mcu:index,failedOrdinaryRestarts:failureIDs.length,readyGenerations:addresses.length,configuration:firmware.map(m=>m.configuration),configurationTraffic:firmware.map(m=>m.configurationTraffic),readyPersistentDescriptors,deviceAcquisitions:adapters,deviceReleases:adapters,sameSocket:true,sameListener:true});
   }finally{socket?.terminate();if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await ended;await f.close();}
  }
  const sorted=latencies.toSorted((a,b)=>a-b),p99=sorted[Math.ceil(sorted.length*.99)-1];assert(p99<20,JSON.stringify({p99,queries:sorted.length}));t.diagnostic(JSON.stringify({bundleSha256:createHash('sha256').update(await readFile(join(app,'build-info.json'))).digest('hex'),results,queries:sorted.length,queryP99Ms:p99,hardwareAcceptance:false,firmwareRestartRouteImplemented:true}));
 }finally{await rm(root,{recursive:true,force:true});}
});
