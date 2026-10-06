import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebSocket} from 'ws';
import {PrintController,type PrintDevice} from '../src/operations/print.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {MaintenanceGate,MaintenanceBusyError} from '../src/operations/maintenance-gate.ts';
import {ProductPrintApi,registerProductPrintApi} from '../src/moonraker/product-print-api.ts';
import {ApiError,JsonRpcDispatcher} from '../src/moonraker/rpc.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {MoonrakerNetwork} from '../src/moonraker/server.ts';

for(const standard of [false,true])for(const transport of ['http','websocket'] as const)test(`${standard?'standard':'native'} ${transport}: maintenance rejection identifies its owner without reserving or replaying a job`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'print-conflict-')),journal=await PrintJournal.open({path:join(dir,'jobs.db'),deviceId:'printer'}),gate=new MaintenanceGate(),calls:string[]=[];
 const device:PrintDevice={async prepare(){calls.push('prepare');},async start(){calls.push('start');},async pause(){},async resume(){},async finish(){},async stop(){}};
 const controller=new PrintController(device,{maxNozzle:300,maxBed:120},{},{journal,maintenanceGate:gate});
 const api=new ProductPrintApi(controller,gate,undefined,{async start(){return {fileId:'file',nozzle:200,bed:60};}}),rpc=new JsonRpcDispatcher(),registry=new EndpointRegistry(rpc),unregister=registerProductPrintApi(registry,api);
 const network=new MoonrakerNetwork(rpc,{endpoints:registry,authorize(_method,_params,{request}){if(request.headers['x-test-identity']!=='operator')throw new ApiError(401,'Denied');}}),address=await network.listen(),base='http://127.0.0.1:'+address.port;
 let socket:WebSocket|undefined,release=gate.acquire(),sequence=0;const token=controller.stateToken;
 const request={version:1,request_id:'job',file_id:'file',nozzle:200,bed:60,expires_at:Date.now()+30000},params=standard?{filename:'file.gcode'}:request;
 const invoke=async()=>{
  if(transport==='http'){const response=await fetch(base+'/printer/print/start',{method:'POST',headers:{'content-type':'application/json','x-test-identity':'operator'},body:JSON.stringify(params)});return {status:response.status,body:await response.json() as any};}
  const message=once(socket!,'message');socket!.send(JSON.stringify({jsonrpc:'2.0',id:++sequence,method:'printer.print.start',params}));const body=JSON.parse(String((await message)[0]));return {status:body.error?.code??200,body};
 };
 try{
  const denied=await fetch(base+'/printer/print/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(params)});assert.equal(denied.status,401);assert.equal((await denied.json() as any).error.data,undefined);
  if(transport==='websocket'){socket=new WebSocket(base.replace('http:','ws:')+'/websocket',{headers:{'x-test-identity':'operator'}});await once(socket,'open');}
  const conflict=await invoke();assert.equal(conflict.status,409);assert.deepEqual(conflict.body.error.data,{reason:'maintenance_active'});assert.equal(controller.state,'idle');assert.equal(controller.currentRequest,undefined);assert.equal(controller.stateToken,token);assert.deepEqual(calls,[]);assert.equal(await journal.active(),null);assert.equal(await journal.get('job'),null);
  release();await new Promise<void>(resolve=>setImmediate(resolve));assert.deepEqual(calls,[],'Releasing maintenance must not replay rejected work');
  const admitted=await invoke();assert.equal(admitted.status,200);const current=controller.currentRequest!;await controller.start(current);assert.deepEqual(calls,['prepare','start']);assert.equal((await journal.get(current.requestId))?.state,'started');
 }finally{release();socket?.terminate();unregister();await network.close();await api.close();await controller.retire();await journal.close();await rm(dir,{recursive:true,force:true});}
});

test('closed admission and bounded activity capacity report distinct reasons without admitting a print',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'print-conflict-capacity-')),journal=await PrintJournal.open({path:join(dir,'jobs.db'),deviceId:'printer'}),gate=new MaintenanceGate(),leases:(()=>void)[]=[];
 const noop=async()=>{},controller=new PrintController({prepare:noop,start:noop,pause:noop,resume:noop,finish:noop,stop:noop},{maxNozzle:300,maxBed:120},{},{journal,maintenanceGate:gate}),api=new ProductPrintApi(controller,gate),context={signal:new AbortController().signal,transport:'http' as const,authorize(){}},request={version:1,request_id:'job',file_id:'file',nozzle:200,bed:60,expires_at:Date.now()+30000};
 try{
  for(let i=0;i<65536;i++)leases.push(gate.activity());
  await assert.rejects(api.call('start',request,context),error=>error instanceof ApiError&&error.status===409&&JSON.stringify(error.data)===JSON.stringify({reason:'activity_capacity'}));
  for(const release of leases.splice(0))release();gate.invalidate();
  await assert.rejects(api.call('start',request,context),error=>error instanceof ApiError&&error.status===409&&JSON.stringify(error.data)===JSON.stringify({reason:'admission_closed'}));
  assert.equal(controller.state,'idle');assert.equal(await journal.get('job'),null);
 }finally{for(const release of leases)release();await api.close();await controller.retire();await journal.close();await rm(dir,{recursive:true,force:true});}
});

for(const maintenance of [false,true])test(`${maintenance?'typed':'ordinary'} producer errors preserve their category without exposing internal messages`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'print-conflict-producer-')),journal=await PrintJournal.open({path:join(dir,'jobs.db'),deviceId:'printer'}),gate=new MaintenanceGate(),noop=async()=>{};
 const rejected=maintenance?new MaintenanceBusyError('private producer detail'):Object.assign(new Error('private producer detail'),{reason:'maintenance_active'});
 const controller=new PrintController({prepare:noop,start:noop,pause:noop,resume:noop,finish:noop,stop:noop},{maxNozzle:300,maxBed:120},{},{journal,maintenanceGate:gate,beforeStart(){throw rejected;}}),api=new ProductPrintApi(controller,gate);
 try{
  await assert.rejects(api.call('start',{version:1,request_id:'job',file_id:'file',nozzle:200,bed:60,expires_at:Date.now()+30000},{signal:new AbortController().signal,transport:'http',authorize(){}}),error=>error instanceof ApiError&&error.status===409&&JSON.stringify(error.data)===JSON.stringify(maintenance?{reason:'producer_busy'}:undefined)&&error.message==='Print request was not completed; query request state');
  assert.equal(controller.state,'idle');assert.equal(await journal.get('job'),null);
 }finally{await api.close();await controller.retire();await journal.close();await rm(dir,{recursive:true,force:true});}
});
