import test from 'node:test';
import assert from 'node:assert/strict';
import {ProductHostControl} from '../src/runtime/product-host-control.ts';
import {registerProductHostControl} from '../src/moonraker/product-host-api.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {NativeRequestScope} from '../src/moonraker/native-request-scope.ts';
import {JsonRpcDispatcher,ApiError,type RpcContext} from '../src/moonraker/rpc.ts';
test('firmware restart authorizes POST/RPC, rejects unavailable strategies and waits for response handoff',async()=>{
 const control=new ProductHostControl(),registry=new EndpointRegistry(new JsonRpcDispatcher());const remove=registerProductHostControl(registry,control);let calls=0,sent:((sent:boolean)=>void)|undefined;
 const context:RpcContext={transport:'http',signal:new AbortController().signal,authorize(){},afterResponse(cb){sent=cb;}};
 await assert.rejects(registry.invoke('/printer/firmware_restart','POST',{},context),e=>e instanceof ApiError&&e.status===503);
 control.attach(async kind=>{assert.equal(kind,'firmware_restart');calls++;},()=>{},{kinds:['firmware_restart']});
 await assert.rejects(registry.invoke('/printer/firmware_restart','POST',{}, {...context,authorize(){throw new ApiError(401,'Denied');}}),e=>e instanceof ApiError&&e.status===401);
 await assert.rejects(registry.invoke('/printer/firmware_restart','POST',{unexpected:true},context),e=>e instanceof ApiError&&e.status===400);
 assert.equal(await registry.invoke('/printer/firmware_restart','POST',{},context),'ok');assert.equal(calls,0);assert.equal(control.status.firmware_restart_operation?.kind,'firmware_restart');sent!(true);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
 const reply=JSON.parse((await registry.dispatcher.dispatch(JSON.stringify({jsonrpc:'2.0',id:2,method:'printer.firmware_restart'}),{...context,transport:'websocket'}))!);assert.equal(reply.result,'ok');sent!(false);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);assert.equal(control.status.firmware_restart_operation?.state,'failed');remove();await control.close();
});
test('standard RESTART returns ok for authorized POST and RPC only after durable admission',async()=>{
 const control=new ProductHostControl(),registry=new EndpointRegistry(new JsonRpcDispatcher());const release=registerProductHostControl(registry,control);let calls=0,sent:((sent:boolean)=>void)|undefined;
 control.attach(async kind=>{assert.equal(kind,'restart');calls++;});const context:RpcContext={transport:'http',signal:new AbortController().signal,authorize(){},afterResponse(cb){sent=cb;}};
 await assert.rejects(registry.invoke('/printer/restart','POST',{}, {...context,authorize(){throw new ApiError(401,'Denied');}}),e=>e instanceof ApiError&&e.status===401);
 await assert.rejects(registry.invoke('/printer/restart','POST',{unexpected:true},context),e=>e instanceof ApiError&&e.status===400);
 assert.equal(await registry.invoke('/printer/restart','POST',{},context),'ok');assert.equal(control.status.restart_operation?.state,'queued');assert.equal(calls,0);sent!(true);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
 const reply=JSON.parse((await registry.dispatcher.dispatch(JSON.stringify({jsonrpc:'2.0',id:2,method:'printer.restart'}),{...context,transport:'websocket'}))!);assert.equal(reply.result,'ok');assert.equal(calls,1);sent!(false);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);assert.equal(control.status.restart_operation?.state,'failed');
 release();assert.equal(registry.allowed('/printer/restart'),undefined);assert.equal(registry.allowed('/printer/firmware_restart'),undefined);await control.close();
});
test('host endpoints require authorization, versioned identity, state token and response handoff',async()=>{
 const control=new ProductHostControl(),registry=new EndpointRegistry(new JsonRpcDispatcher()),release=registerProductHostControl(registry,control),methods:string[]=[];let calls=0;control.attach(async()=>{calls++;});
 const params={version:1,request_id:'recover',state_token:control.status.state_token},context:RpcContext={transport:'http',signal:new AbortController().signal,authorize(method){methods.push(method);}};
 const invoke=(body:typeof params|Record<string,string|number>,ctx=context)=>registry.invoke('/printer/host/reinitialize','POST',body,ctx);
 await assert.rejects(invoke(params,{...context,authorize(){throw new ApiError(401,'Denied');}}),error=>error instanceof ApiError&&error.status===401);assert.equal(control.operation('recover'),null);
 await assert.rejects(invoke(params),error=>error instanceof ApiError&&error.status===503);
 await assert.rejects(invoke({...params,version:2}),error=>error instanceof ApiError&&error.status===400);
 let sent:((sent:boolean)=>void)|undefined;const reply=await invoke(params,{...context,afterResponse(callback){sent=callback;}}) as any;assert.equal(reply.accepted,true);assert.equal(reply.operation.state,'queued');assert.equal(calls,0);sent!(true);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
 const status=await registry.invoke('/printer/host/status','GET',{request_id:'recover'},context) as any;assert.equal(status.operation.state,'succeeded');assert(methods.includes('printer.host.reinitialize'));assert(methods.includes('printer.host.status'));release();assert.equal(registry.allowed('/printer/host/status'),undefined);
});
test('WebSocket RPC recovery is authorized and dispatches only after batch response handoff',async()=>{
 const control=new ProductHostControl(),registry=new EndpointRegistry(new JsonRpcDispatcher());registerProductHostControl(registry,control);let calls=0,sent:((sent:boolean)=>void)|undefined;control.attach(async()=>{calls++;});
 const reply=JSON.parse((await registry.dispatcher.dispatch(JSON.stringify([{jsonrpc:'2.0',id:1,method:'printer.host.reinitialize',params:{version:1,request_id:'ws',state_token:control.status.state_token}},{jsonrpc:'2.0',id:2,method:'printer.host.status',params:{request_id:'ws'}}]),{transport:'websocket',signal:new AbortController().signal,authorize(){},afterResponse(callback){sent=callback;}}))!);assert.equal(calls,0);assert.equal(reply[0].result.operation.state,'queued');assert.equal(reply[1].result.operation.state,'queued');sent!(true);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);assert.equal(control.operation('ws')?.state,'succeeded');
});

function clearFileFixture(initial='interrupted'){
 const scope=new NativeRequestScope(),control=new ProductHostControl(),registry=new EndpointRegistry(new JsonRpcDispatcher(),scope.wrap),generation={signal:scope.signal,abort(_reason?:unknown){scope.retire();}},calls:string[]=[];
 let current={state:initial,state_token:'token-old',request:initial==='idle'?null:{request_id:'old-request'},closed:false,pending_device_actions:0,safe_stop_pending:false},cancelledDurably=false;
 let cancelHook:(()=>Promise<void>)|undefined;
 registerProductHostControl(registry,control);
 registry.register({endpoint:'/printer/print/status',methods:['GET']},()=>{calls.push('status');return structuredClone(current);});
 registry.register({endpoint:'/printer/print/cancel',methods:['POST']},async params=>{calls.push('cancel');if(params.request_id!==current.request?.request_id||params.state_token!==current.state_token)throw new ApiError(409,'Current request or token changed');await cancelHook?.();current={...current,state:'cancelled',state_token:'token-cancelled'};cancelledDurably=true;return 'ok';});
 registry.register({endpoint:'/printer/print/reset',methods:['POST']},params=>{calls.push('reset');if(params.request_id!==current.request?.request_id||params.state_token!==current.state_token)throw new ApiError(409,'Current request or token changed');assert(['completed','cancelled'].includes(current.state));current={...current,state:'idle',state_token:'token-idle',request:null};return 'ok';});
 const context:RpcContext={transport:'http',signal:new AbortController().signal,nativeGenerationSignal:generation.signal,authorize(){}};
 return {control,registry,generation,calls,context,get state(){return current;},set state(value){current=value;},get cancelledDurably(){return cancelledDurably;},set cancelHook(value:typeof cancelHook){cancelHook=value;},clear:(script='SDCARD_RESET_FILE',ctx=context)=>registry.invoke('/printer/gcode/script','POST',{script},ctx)};
}

test('external clear-file preserves canonical terminal reset and safe idle idempotence',async()=>{
 for(const initial of ['completed','cancelled','idle']){const f=clearFileFixture(initial);try{assert.equal(await f.clear(' sdcard_reset_file '),'ok');assert.equal(f.state.state,'idle');assert.deepEqual(f.calls,initial==='idle'?['status']:['status','reset']);assert.equal(f.cancelledDurably,false);}finally{await f.control.close();}}
});

test('external clear-file cancels the original interrupted, failed, active or paused task before reset',async()=>{
 for(const initial of ['interrupted','failed','preparing','printing','paused']){const f=clearFileFixture(initial);try{assert.equal(await f.clear(),'ok');assert.equal(f.cancelledDurably,true);assert.deepEqual(f.calls,['status','cancel','status','reset']);assert.equal(f.state.state,'idle');}finally{await f.control.close();}}
});

test('clear-file rejects parameters, embedded newlines and multiple commands without invoking print owners',async()=>{
 const f=clearFileFixture();try{for(const script of ['SDCARD_RESET_FILE X=1','SDCARD_RESET_FILE\nG28','SDCARD_RESET_FILE; G28','SDCARD_RESET_FILE\rRESTART','SDCARD_RESET_FILE\nSDCARD_RESET_FILE'])await assert.rejects(f.clear(script),error=>error instanceof ApiError&&error.status===400);assert.deepEqual(f.calls,[]);}finally{await f.control.close();}
});

test('clear-file reauthorizes canonical actions and keeps rejection visible without reset or retry',async()=>{
 for(const denied of ['printer.gcode.script','printer.print.status','printer.print.cancel','printer.print.reset']){const f=clearFileFixture();try{await assert.rejects(f.clear(undefined,{...f.context,authorize(method){if(method===denied)throw new ApiError(403,'Denied');}}),error=>error instanceof ApiError&&error.status===403);assert(!f.calls.includes('reset'));assert(f.calls.filter(call=>call==='cancel').length<=1);assert.equal(f.state.state,denied==='printer.print.reset'?'cancelled':'interrupted');}finally{await f.control.close();}}
});

test('clear-file rejects stale generations including retirement during deferred canonical authorization',async()=>{
 const f=clearFileFixture();try{
  await assert.rejects(f.clear(undefined,{...f.context,nativeGenerationSignal:undefined}),error=>error instanceof ApiError&&error.status===503);
  await assert.rejects(f.clear(undefined,{...f.context,nativeGenerationRetiredAtAdmission:true}),error=>error instanceof ApiError&&error.status===503);assert.deepEqual(f.calls,[]);
  await assert.rejects(f.clear(undefined,{...f.context,nativeGenerationSignal:new AbortController().signal}),error=>error instanceof ApiError&&error.status===503);assert.deepEqual(f.calls,[]);
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();const clearing=f.clear(undefined,{...f.context,async authorize(method){if(method==='printer.print.cancel'){entered.resolve();await release.promise;}}});void clearing.catch(()=>{});await entered.promise;f.generation.abort(new ApiError(503,'Generation retired'));release.resolve();await assert.rejects(clearing,error=>error instanceof ApiError&&error.status===503);assert.deepEqual(f.calls,['status']);assert.equal(f.state.request?.request_id,'old-request');
 }finally{await f.control.close();}
});

test('clear-file waits for safe durable cancel and never resets a replacement request',async()=>{
 const f=clearFileFixture();try{const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();f.cancelHook=async()=>{entered.resolve();await release.promise;};const clearing=f.clear();await entered.promise;assert.deepEqual(f.calls,['status','cancel']);assert.equal(f.cancelledDurably,false);release.resolve();assert.equal(await clearing,'ok');assert.equal(f.cancelledDurably,true);assert.deepEqual(f.calls,['status','cancel','status','reset']);}finally{await f.control.close();}
 const changed=clearFileFixture();try{changed.cancelHook=async()=>{changed.state={...changed.state,request:{request_id:'replacement'}};};await assert.rejects(changed.clear(),error=>error instanceof ApiError&&error.status===409);assert(!changed.calls.includes('reset'));assert.equal(changed.state.request?.request_id,'replacement');}finally{await changed.control.close();}
});

test('failed cancel, aborted cancellation and unsafe idle never turn clear-file into a successful reset',async()=>{
 const f=clearFileFixture();try{f.cancelHook=async()=>{throw new ApiError(503,'Durable cancel failed');};await assert.rejects(f.clear(),error=>error instanceof ApiError&&error.status===503);assert.deepEqual(f.calls,['status','cancel']);assert.equal(f.cancelledDurably,false);assert.equal(f.state.state,'interrupted');}finally{await f.control.close();}
 const retired=clearFileFixture();try{retired.cancelHook=async()=>{retired.generation.abort(new ApiError(503,'Retired during stop'));};await assert.rejects(retired.clear(),error=>error instanceof ApiError&&error.status===503);assert(!retired.calls.includes('reset'));}finally{await retired.control.close();}
 for(const change of [{closed:true},{pending_device_actions:1},{safe_stop_pending:true},{request:{request_id:'unexpected'}}]){const idle=clearFileFixture('idle');try{idle.state={...idle.state,...change};await assert.rejects(idle.clear());assert.deepEqual(idle.calls,['status']);}finally{await idle.control.close();}}
});

test('clear-file cannot cancel after canonical authorization replaces the observed token or request',async()=>{
 for(const changedId of [false,true]){const f=clearFileFixture();try{await assert.rejects(f.clear(undefined,{...f.context,authorize(method){if(method==='printer.print.cancel')f.state={...f.state,state_token:'changed-before-cancel',request:{request_id:changedId?'new-request':'old-request'}};}}),error=>error instanceof ApiError&&error.status===409);assert.deepEqual(f.calls,['status','cancel']);assert.equal(f.cancelledDurably,false);assert.equal(f.state.state,'interrupted');}finally{await f.control.close();}}
});
