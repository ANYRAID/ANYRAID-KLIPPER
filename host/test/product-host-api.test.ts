import test from 'node:test';
import assert from 'node:assert/strict';
import {ProductHostControl} from '../src/runtime/product-host-control.ts';
import {registerProductHostControl} from '../src/moonraker/product-host-api.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
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
