import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import WebSocket from 'ws';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
import {PrintController,type PrintDevice} from '../src/operations/print.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
import {FilePrintDevice} from '../src/operations/file-print-device.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
const info={connected:false,state:'disconnected' as const,components:[],failedComponents:[],directories:[],warnings:[],version:'test',missingRequirements:[]};
const until=async(check:()=>boolean)=>{const end=Date.now()+4000;while(!check()){assert.ok(Date.now()<end,'Print notification condition timed out');await new Promise(r=>setTimeout(r,5));}};
test('native HTTP file print publishes authorized lifecycle states through EOF drain and reset',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'print-events-')),gate=new MaintenanceGate(),journal=await PrintJournal.open({path:join(dir,'journal.db'),deviceId:'printer'}),files=await PublishedPrintFiles.open(join(dir,'files'));
 const drained=Promise.withResolvers<void>(),prepared=Promise.withResolvers<void>(),events:string[]=[],commands:string[]=[];
 const dispatch=new GCodeDispatch({output(){},shutdown(){}});dispatch.register('G1',command=>{commands.push(command.rawParameters());});
 const device=new FilePrintDevice({async prepare(){events.push('prepare');await prepared.promise;dispatch.setReady(true);},async start(){events.push('start');},async pause(){},async resume(){},async finish(){events.push('drain');await drained.promise;},async stop(){prepared.resolve();drained.resolve();}},dispatch,(id,signal)=>files.acquire(id,signal));
 const controller=new PrintController(device,{maxNozzle:300,maxBed:120},{},{journal,maintenanceGate:gate});let service:ConfiguredMoonraker|undefined;const sockets:WebSocket[]=[];
 try{
  const source=join(dir,'input.gcode');await writeFile(source,'G1 X1\nG1 X2\n');const input=await open(source,'r');try{await files.publish('file','part.gcode',input,new AbortController().signal);}finally{await input.close();}
  const path=join(dir,'main.conf');await writeFile(path,'[server]\nhost=127.0.0.1\nport=0');
  service=await ConfiguredMoonraker.load(path,{productPrint:controller,maintenanceGate:gate,information:info,authorize:()=>{},authorizeNotification(method,params,context){assert.equal(method,'notify_print_state_changed');assert.equal(params.length,1);if(context.request.headers['x-observer']!=='allowed')throw new Error('No observation permission');}});
  const address=await service.start(),base=`http://127.0.0.1:${address.port}`;
  const received:any[][]=[[],[]];for(const [i,permission] of ['allowed','denied'].entries()){const socket=new WebSocket(base.replace('http:','ws:')+'/websocket',{headers:{'x-observer':permission}});socket.on('message',data=>received[i].push(JSON.parse(data.toString())));sockets.push(socket);await once(socket,'open');}
  const post=async(action:string,params:unknown)=>{const response=await fetch(base+'/printer/print/'+action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(params)});assert.equal(response.status,200);return response.json();};
  await post('start',{version:1,request_id:'job',file_id:'file',nozzle:0,bed:0,expires_at:Date.now()+60000});await until(()=>received[0].some(e=>e.params[0].state==='preparing'));
  prepared.resolve();await until(()=>received[0].some(e=>e.params[0].state==='finishing'));assert.equal(controller.state,'finishing');assert.deepEqual(commands,['X1','X2']);assert.ok(events.includes('drain'));assert.equal(received[0].some(e=>e.params[0].state==='completed'),false);
  drained.resolve();await until(()=>received[0].some(e=>e.params[0].state==='completed'));assert.equal((await journal.get('job'))?.state,'completed');
  await post('reset',{request_id:'job',state_token:controller.stateToken});await until(()=>received[0].some(e=>e.params[0].state==='idle'));
  const latest=received[0].at(-1).params[0];assert.deepEqual(latest,{state:'idle',state_token:controller.stateToken,request_id:null});assert.equal(received[1].length,0);assert.ok(service.printNotifications.denied>0);
  for(const event of received[0]){assert.equal(event.method,'notify_print_state_changed');assert.equal(Object.keys(event.params[0]).length,3);}
  const status=await (await fetch(base+'/printer/print/status')).json();assert.equal(status.result.state_token,latest.state_token);
 }finally{prepared.resolve();drained.resolve();for(const socket of sockets)socket.terminate();await service?.close();assert.equal(controller.stateObservers,0);await files.close();await journal.close();await rm(dir,{recursive:true,force:true});}
});
test('held notification authorization cannot hold native start or emergency stop',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'slow-print-events-')),gate=new MaintenanceGate(),journal=await PrintJournal.open({path:join(dir,'journal.db'),deviceId:'printer'}),held=Promise.withResolvers<void>();let stops=0,service:ConfiguredMoonraker|undefined,socket:WebSocket|undefined;
 const device:PrintDevice={async prepare(){},async start(){},async pause(){},async resume(){},async finish(){},async stop(){stops++;}},controller=new PrintController(device,{maxNozzle:300,maxBed:120},{},{journal,maintenanceGate:gate});
 try{
  const path=join(dir,'main.conf');await writeFile(path,'[server]\nhost=127.0.0.1\nport=0');service=await ConfiguredMoonraker.load(path,{productPrint:controller,maintenanceGate:gate,information:info,authorize:()=>{},authorizeNotification:()=>held.promise,notificationLimits:{pending:2,perClient:2,timeoutMs:2000}});
  const address=await service.start();socket=new WebSocket(`ws://127.0.0.1:${address.port}/websocket`);await once(socket,'open');
  await controller.start({version:1,requestId:'job',fileId:'file',nozzle:0,bed:0});await until(()=>service!.printNotifications.received>=2);
  for(const action of ['pause','resume'] as const){const before=service.printNotifications.received;await controller[action]();await until(()=>service!.printNotifications.received>before);}
  await controller.fault(new Error('device emergency'));
  assert.equal(controller.state,'failed');assert.equal(stops,1);await until(()=>!!service?.printNotifications.overflow);assert.ok(service.printNotifications.received>=3);
 }finally{held.resolve();socket?.terminate();await service?.close();assert.equal(controller.stateObservers,0);await journal.close();await rm(dir,{recursive:true,force:true});}
});
