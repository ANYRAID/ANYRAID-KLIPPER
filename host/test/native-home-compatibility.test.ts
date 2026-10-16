import test from 'node:test';
import assert from 'node:assert/strict';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {ApiError,JsonRpcDispatcher,type RpcContext,type Json} from '../src/moonraker/rpc.ts';
import {NativeRequestScope} from '../src/moonraker/native-request-scope.ts';
import {registerNativeProbe} from '../src/moonraker/native-probe.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {registerProductHostControl} from '../src/moonraker/product-host-api.ts';
import {ProductHostControl} from '../src/runtime/product-host-control.ts';
function fixture(){const scope=new NativeRequestScope(),gate=new MaintenanceGate(),registry=new EndpointRegistry(new JsonRpcDispatcher(),scope.wrap),control=new ProductHostControl(),calls:number[][]=[];let idle=true;
 const release=registerProductHostControl(registry,control),close=registerNativeProbe(registry,gate,{idle:()=>idle,measure:async(_signal,axes)=>{calls.push([...(axes??[])]);return {homed_axes:'xyz'};},synchronize(){}},'home');
 const context:RpcContext={transport:'http',signal:new AbortController().signal,nativeGenerationSignal:scope.signal,authorize(){}};
 return {scope,gate,registry,calls,context,setIdle(value:boolean){idle=value;},async close(){release();await close();await scope.drain();await control.close();}};
}
test('standard G28 HTTP and RPC use typed homing with exact axis selectors',async()=>{const f=fixture();try{
 for(const [script,axes] of [['G28',[0,1,2]],['g28 x',[0]],['G28Y0Z0 ; selectors only',[1,2]]] as const){assert.equal(await f.registry.invoke('/printer/gcode/script','POST',{script},f.context),'ok');assert.deepEqual(f.calls.at(-1),axes);}
 const reply=JSON.parse((await f.registry.dispatcher.dispatch(JSON.stringify({jsonrpc:'2.0',id:1,method:'printer.gcode.script',params:{script:'G28 Z'}}),{...f.context,transport:'websocket'}))!);assert.equal(reply.result,'ok');assert.deepEqual(f.calls.at(-1),[2]);
}finally{await f.close();}});
test('compatibility authorization, payload, idle and generation failures never admit homing',async()=>{const f=fixture();try{
 for(const script of ['G1 X1','G28 X\nG1 Y1','G28 E','G28\0','G28 F100'])await assert.rejects(f.registry.invoke('/printer/gcode/script','POST',{script},f.context),e=>e instanceof ApiError&&e.status===400);
 await assert.rejects(f.registry.invoke('/printer/gcode/script','POST',{script:'G28',state_token:'caller'},f.context),e=>e instanceof ApiError&&e.status===400);
 await assert.rejects(f.registry.invoke('/printer/gcode/script','POST',{script:'G28'},{...f.context,authorize(method){if(method==='printer.calibration.post_home')throw new ApiError(403,'Home denied');}}),e=>e instanceof ApiError&&e.status===403);
 f.setIdle(false);await assert.rejects(f.registry.invoke('/printer/gcode/script','POST',{script:'G28'},f.context),e=>e instanceof ApiError&&e.status===409);f.setIdle(true);
 await assert.rejects(f.registry.invoke('/printer/gcode/script','POST',{script:'G28'},{...f.context,nativeGenerationSignal:undefined}),e=>e instanceof ApiError&&e.status===503);
 await assert.rejects(f.registry.invoke('/printer/gcode/script','POST',{script:'G28'},{...f.context,nativeGenerationRetiredAtAdmission:true}),e=>e instanceof ApiError&&e.status===503);
 assert.equal(f.calls.length,0);
}finally{await f.close();}});
test('typed home retries require the same normalized axis set and reject changed arguments',async()=>{const f=fixture();try{
 const path='/printer/calibration/home',state=await f.registry.invoke(path,'GET',{},f.context) as Record<string,Json>,params={version:1,state_token:state.state_token,axes:[1,0]};
 const first=await f.registry.invoke(path,'POST',params,f.context);assert.deepEqual(f.calls,[[0,1]]);assert.deepEqual(await f.registry.invoke(path,'POST',{...params,axes:[0,1]},f.context),first);assert.equal(f.calls.length,1);
 await assert.rejects(f.registry.invoke(path,'POST',{...params,axes:[2]},f.context),e=>e instanceof ApiError&&e.status===409);
 for(const axes of [[],[0,0],[3],[-1],[1.5],['x']])await assert.rejects(f.registry.invoke(path,'POST',{...params,axes},f.context),e=>e instanceof ApiError&&e.status===400);assert.equal(f.calls.length,1);
}finally{await f.close();}});
test('authorization delayed across retirement cannot obtain or move a replacement homing owner',async()=>{
 let scope=new NativeRequestScope();const registry=new EndpointRegistry(new JsonRpcDispatcher(),(path,handler)=>scope.wrap(path,handler)),control=new ProductHostControl(),release=registerProductHostControl(registry,control),entered=Promise.withResolvers<void>(),resume=Promise.withResolvers<void>();let oldCalls=0,newCalls=0;
 let close=registerNativeProbe(registry,new MaintenanceGate(),{idle:()=>true,measure:async()=>{oldCalls++;return {};},synchronize(){}},'home');
 const context:RpcContext={transport:'http',signal:new AbortController().signal,nativeGenerationSignal:scope.signal,async authorize(method){if(method==='printer.calibration.post_home'){entered.resolve();await resume.promise;}}};
 try{const running=registry.invoke('/printer/gcode/script','POST',{script:'G28'},context).catch(error=>error);await entered.promise;scope.retire();await close();scope=new NativeRequestScope();close=registerNativeProbe(registry,new MaintenanceGate(),{idle:()=>true,measure:async()=>{newCalls++;return {};},synchronize(){}},'home');resume.resolve();const result=await running;assert(result instanceof ApiError||result instanceof Error);assert.equal(oldCalls,0);assert.equal(newCalls,0);
 }finally{resume.resolve();release();await close();await scope.drain();await control.close();}
});
