import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeHostNotifications} from '../src/moonraker/native-host-notifications.ts';
import type {NativeHostSnapshot} from '../src/moonraker/native-host-status.ts';
const initial=():NativeHostSnapshot=>({group_state:'connecting',hardware_state:'starting',print_state:'idle',homed_axes:'',closing:false,admission_closed:false,maintenance:false,mcus:[{id:'mcu',state:'warming'}]});
test('native lifecycle reports each live transition once, recovers observation and stops sampling on close',()=>{
 let state=initial(),failed=false;const events:string[]=[],observer=new NativeHostNotifications(()=>{if(failed)throw Error('private');return state;},event=>events.push(event));
 observer.sample();assert.equal(observer.status.samples,0);observer.start();observer.start();assert.deepEqual(events,[]);
 state={...state,group_state:'ready',hardware_state:'ready',mcus:[{id:'mcu',state:'ready'}]};observer.sample();observer.sample();assert.deepEqual(events,['notify_klippy_ready']);
 state.print_state='printing';observer.sample();state.print_state='paused';observer.sample();assert.equal(events.length,1);
 state.print_state='failed';observer.sample();observer.sample();assert.equal(events.at(-1),'notify_klippy_shutdown');
 failed=true;observer.sample();observer.sample();assert.equal(events.at(-1),'notify_klippy_disconnected');assert.equal(events.length,3);
 failed=false;state.print_state='idle';observer.sample();assert.equal(events.at(-1),'notify_klippy_ready');observer.close();const samples=observer.status.samples;observer.sample();assert.equal(observer.status.samples,samples);assert.throws(()=>observer.start(),/closed/);
});
test('observation and emitter failures do not escape to the device safety path',()=>{
 const observer=new NativeHostNotifications(()=>({...initial(),group_state:'failed'}),()=>{throw Error('output failed');});observer.start();assert.equal(observer.status.failures,1);observer.sample();assert.equal(observer.status.failures,1);observer.close();
});

test('authorized native lifecycle broadcasts reach clients while held policy cannot delay physical stop',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises'),{join}=await import('node:path'),{tmpdir}=await import('node:os'),{once}=await import('node:events'),{default:WebSocket}=await import('ws');
 const {ConfiguredMoonraker}=await import('../src/moonraker/configured-server.ts'),{PrintController}=await import('../src/operations/print.ts'),{PrintJournal}=await import('../src/operations/print-journal.ts'),{MaintenanceGate}=await import('../src/operations/maintenance-gate.ts');
 const dir=await mkdtemp(join(tmpdir(),'native-events-')),gate=new MaintenanceGate(),journal=await PrintJournal.open({path:join(dir,'jobs.db'),deviceId:'printer'}),held=Promise.withResolvers<void>();let stops=0,readError=false,reads=0,state=initial();
 const controller=new PrintController({async prepare(){},async start(){},async pause(){},async resume(){},async finish(){},async stop(){stops++;}},{maxNozzle:300,maxBed:130},{},{journal,maintenanceGate:gate}),sockets:InstanceType<typeof WebSocket>[]=[],events:string[][]=[[],[],[]];let service:Awaited<ReturnType<typeof ConfiguredMoonraker.load>>|undefined;
 const until=async(check:()=>boolean)=>{const end=Date.now()+3000;while(!check()){assert(Date.now()<end,'Lifecycle notification timeout');await new Promise(r=>setTimeout(r,5));}};
 try{
  const config=join(dir,'moonraker.conf');await writeFile(config,'[server]\nhost=127.0.0.1\nport=0');
  service=await ConfiguredMoonraker.load(config,{productPrint:controller,maintenanceGate:gate,nativePrinterIdentity:{configFile:join(dir,'printer.cfg'),softwareVersion:'test'},nativeHost:()=>{reads++;if(readError)throw Error('private failure');return {...state,print_state:controller.state};},information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'test',missingRequirements:[]},authorize(){},notificationLimits:{pending:16,perClient:2,timeoutMs:3000},authorizeNotification(method,params,context){if(!method.startsWith('notify_klippy_'))throw Error('Not subscribed');assert.deepEqual(params,[]);const role=context.request.headers['x-role'];if(role==='slow')return held.promise;if(role!=='allowed')throw Error('Denied');}});
  const {port}=await service.start();for(const [i,role] of ['allowed','denied','slow'].entries()){const socket=new WebSocket('ws://127.0.0.1:'+port+'/websocket',{headers:{'x-role':role}});socket.on('message',bytes=>{const message=JSON.parse(bytes.toString());if(message.method.startsWith('notify_klippy_'))events[i].push(message.method);});sockets.push(socket);await once(socket,'open');}
  state={...state,group_state:'ready',hardware_state:'ready',mcus:[{id:'mcu',state:'ready'}]};await until(()=>events[0].length===1);assert.equal(events[0][0],'notify_klippy_ready');
  const stopped=controller.fault(new Error('test hardware fault'));await stopped;assert.equal(stops,1);assert.equal(controller.state,'failed');assert.equal(events[2].length,0);await until(()=>events[0].length===2);assert.equal(events[0][1],'notify_klippy_shutdown');
  readError=true;await until(()=>events[0].length===3);assert.equal(events[0][2],'notify_klippy_disconnected');assert.equal(events[1].length,0);assert.equal(events[2].length,0);held.resolve();await until(()=>service!.klippyNotifications.denied>=3);await service.close();const after=reads;await new Promise(r=>setTimeout(r,300));assert.equal(reads,after);
 }finally{held.resolve();for(const socket of sockets)socket.terminate();await service?.close();await journal.close();await rm(dir,{recursive:true,force:true});}
});
