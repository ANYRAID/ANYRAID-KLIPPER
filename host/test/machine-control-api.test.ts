import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {ProductHostControl,machineRecoveryKinds} from '../src/runtime/product-host-control.ts';
import {registerProductHostControl} from '../src/moonraker/product-host-api.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher,ApiError,type RpcContext} from '../src/moonraker/rpc.ts';
import {MachineControlError} from '../src/moonraker/machine-control.ts';
async function until(check:()=>boolean){const end=performance.now()+3000;while(!check()){assert(performance.now()<end,'Machine receipt timeout');await delay(2);}}
test('every standard machine action authorizes HTTP/RPC and waits for the response before dispatch',async()=>{
 const control=new ProductHostControl(),registry=new EndpointRegistry(new JsonRpcDispatcher()),remove=registerProductHostControl(registry,control),calls:string[]=[];let sent:((sent:boolean)=>void)|undefined;
 const context:RpcContext={transport:'http',signal:new AbortController().signal,authorize(){},afterResponse(cb){sent=cb;}};
 const cases=[['/machine/services/start','service_start'],['/machine/services/stop','service_stop'],['/machine/services/restart','service_restart'],['/server/restart','server_restart'],['/machine/reboot','machine_reboot'],['/machine/shutdown','machine_shutdown']];
 try{
  await assert.rejects(registry.invoke('/server/restart','POST',{},context),e=>e instanceof ApiError&&e.status===503);
  control.attach(async(kind,service)=>{calls.push(kind+':'+(service??''));},()=>{},{kinds:machineRecoveryKinds});
  for(const [path,kind] of cases){
   const params:Record<string,string>=path.includes('/services/')?{service:'crowsnest'}:{};
   await assert.rejects(registry.invoke(path,'POST',params,{...context,authorize(){throw new ApiError(401,'Denied');}}),e=>e instanceof ApiError&&e.status===401);
   await assert.rejects(registry.invoke(path,'POST',{...params,force:true},context),e=>e instanceof ApiError&&e.status===400);
   const before=calls.length;assert.equal(await registry.invoke(path,'POST',params,context),'ok');assert.equal(calls.length,before);
   const receipt=control.status.machine_control.operations.find(r=>r.kind===kind)!;assert.equal(receipt.state,'queued');sent!(true);await until(()=>control.operation(receipt.request_id)?.state==='succeeded');assert.equal(calls.length,before+1);
   const reply=JSON.parse((await registry.dispatcher.dispatch(JSON.stringify({jsonrpc:'2.0',id:1,method:path.slice(1).replaceAll('/','.'),params}),{...context,transport:'websocket'}))!);assert.equal(reply.result,'ok');
   const dropped=control.status.machine_control.operations.find(r=>r.kind===kind)!;sent!(false);await until(()=>control.operation(dropped.request_id)?.state==='failed');assert.equal(calls.length,before+1);
  }
 }finally{remove();for(const [path] of cases)assert.equal(registry.allowed(path),undefined);await control.close();}
});
test('machine admission rejects stale generations, missing handoff and trusted permission denial without receipts',async()=>{
 const control=new ProductHostControl(),registry=new EndpointRegistry(new JsonRpcDispatcher()),remove=registerProductHostControl(registry,control),generation=new AbortController();let calls=0;
 control.attach(async()=>{calls++;},()=>{throw new MachineControlError('not_allowed','Denied scope');},{kinds:machineRecoveryKinds,generationSignal:generation.signal});
 const context:RpcContext={transport:'http',signal:new AbortController().signal,authorize(){},nativeGenerationSignal:generation.signal,afterResponse(){throw Error('Must not register handoff');}};
 try{
  await assert.rejects(registry.invoke('/machine/reboot','POST',{}, {...context,afterResponse:undefined}),e=>e instanceof ApiError&&e.status===503);
  await assert.rejects(registry.invoke('/machine/reboot','POST',{}, {...context,nativeGenerationSignal:new AbortController().signal}),e=>e instanceof ApiError&&e.status===503);
  await assert.rejects(registry.invoke('/machine/reboot','POST',{},context),e=>e instanceof ApiError&&e.status===403);
  assert.equal(calls,0);assert.deepEqual(control.status.machine_control.operations,[]);assert.equal(control.status.busy,false);
 }finally{remove();await control.close();}
});
test('only an identical running service request coalesces; queued and different requests conflict',async()=>{
 const control=new ProductHostControl(),finish=Promise.withResolvers<void>();let sent:((sent:boolean)=>void)|undefined,calls=0;
 control.attach(async()=>{calls++;await finish.promise;},()=>{},{kinds:machineRecoveryKinds});
 const action={kind:'service',action:'start',service:'crowsnest'} as const;
 try{
  const receipt=await control.requestMachineAction(action,undefined,undefined,cb=>{sent=cb;});
  await assert.rejects(control.requestMachineAction(action,undefined,undefined,()=>{}),/pending/);sent!(true);await until(()=>calls===1);
  const same=await control.requestMachineAction(action,undefined,undefined,()=>{throw Error('No second handoff');});assert.equal(same.request_id,receipt.request_id);
  await assert.rejects(control.requestMachineAction({...action,service:'other'},undefined,undefined,()=>{}),/pending/);
  await assert.rejects(control.requestMachineAction({kind:'shutdown'},undefined,undefined,()=>{}),/pending/);
  finish.resolve();await until(()=>control.operation(receipt.request_id)?.state==='succeeded');assert.equal(calls,1);
 }finally{finish.resolve();await control.close();}
});
