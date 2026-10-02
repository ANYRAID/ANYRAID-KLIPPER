import test from 'node:test';
import assert from 'node:assert/strict';
import {ProductIdleTimeout} from '../src/operations/product-idle.ts';
import {registerNativeIdleSettings} from '../src/moonraker/native-idle-settings.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {ApiError,JsonRpcDispatcher,type RpcContext} from '../src/moonraker/rpc.ts';
const path='/printer/settings/idle_timeout';
test('idle setting authenticates, fences generations, and retry does not extend expiry',async()=>{
 let now=0,calls=0,available=true;const timers=new Map<()=>void,number>(),idle=new ProductIdleTimeout(600,{now:()=>now,schedule(fn,delay){timers.set(fn,now+delay);return ()=>{timers.delete(fn);};}},()=>({busy:false,printing:false,key:'idle'}),async()=>{calls++;},e=>{throw e;});
 const registry=new EndpointRegistry(new JsonRpcDispatcher()),context:RpcContext={transport:'http',signal:new AbortController().signal,authorize:()=>{}};let close=registerNativeIdleSettings(registry,idle,()=>available);
 const invoke=(verb:string,params:any={})=>registry.invoke(path,verb,params,context) as Promise<any>;
 try{
  const initial=await invoke('GET'),request={version:1,state_token:initial.state_token,timeout:3};
  await assert.rejects(registry.invoke(path,'POST',request,{...context,authorize(){throw new Error('denied');}}),/denied/);assert.equal(idle.status.idle_timeout,600);
  for(const timeout of [0,-1,86401,'3'])await assert.rejects(invoke('POST',{...request,timeout}),/Expected/);
  now=1;const receipt=await invoke('POST',request);assert.equal(receipt.timeout,3);assert.equal(receipt.persisted,false);assert.notEqual(receipt.state_token,initial.state_token);
  now=2;assert.deepEqual(await invoke('POST',request),receipt);await assert.rejects(invoke('POST',{...request,timeout:4}),/conflicts/);
  now=4;for(const [fn] of [...timers]){timers.delete(fn);fn();}await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
  available=false;await assert.rejects(invoke('POST',{version:1,state_token:receipt.state_token,timeout:10}),/unavailable/);available=true;
  let authorize!:()=>void;const authorization=new Promise<void>(resolve=>{authorize=resolve;});
  const pending=registry.invoke(path,'POST',{version:1,state_token:receipt.state_token,timeout:10},{...context,authorize:()=>authorization});
  close();authorize();await assert.rejects(pending,e=>e instanceof ApiError&&e.status===503);assert.equal(idle.status.idle_timeout,3);assert.equal(calls,1);
  close();close=registerNativeIdleSettings(registry,idle,()=>available);await assert.rejects(invoke('POST',{...request,state_token:receipt.state_token}),/Stale/);
  idle.close();await assert.rejects(invoke('POST',request),/unavailable/);
 }finally{close();idle.close();}
});
