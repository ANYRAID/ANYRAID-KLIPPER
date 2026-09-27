import assert from 'node:assert/strict';
import {ProductIdleTimeout} from '../src/operations/product-idle.ts';
import {registerNativeIdleSettings} from '../src/moonraker/native-idle-settings.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher,type RpcContext} from '../src/moonraker/rpc.ts';
const batches:number[]=[],path='/printer/settings/idle_timeout',count=20000;
for(let run=0;run<13;run++){
 let scheduled=0,cancelled=0;
 const idle=new ProductIdleTimeout(600,{now:()=>1,schedule(){scheduled++;return ()=>{cancelled++;};}},()=>({busy:false,printing:false,key:'idle'}),async()=>{throw new Error('Unexpected expiry');},error=>{throw error;});
 const registry=new EndpointRegistry(new JsonRpcDispatcher()),close=registerNativeIdleSettings(registry,idle,()=>true),context:RpcContext={transport:'http',signal:new AbortController().signal,authorize:()=>{}};
 let state=await registry.invoke(path,'GET',{},context) as {state_token:string;timeout:number};
 const start=performance.now();
 for(let i=0;i<count;i++){
  const request={version:1,state_token:state.state_token,timeout:600+i%2};
  state=await registry.invoke(path,'POST',request,context) as typeof state;
  assert.equal(state.timeout,request.timeout);
  // Every accepted update is retried: one timer reset, not two.
  const retry=await registry.invoke(path,'POST',request,context) as typeof state;
  assert.equal(retry.state_token,state.state_token);
 }
 const elapsed=performance.now()-start;
 assert.equal(scheduled,count+1);assert.equal(cancelled,count);
 close();idle.close();assert.equal(cancelled,scheduled);if(run>=2)batches.push(elapsed);
}
batches.sort((a,b)=>a-b);assert(batches[10]<2000);
console.log(JSON.stringify({node:process.version,updates:count,retries:count,samples:11,medianMs:batches[5],p95Ms:batches[10],scope:'Authorized registry calls, token generation, bounded receipt and synthetic timer; excludes network and physical outputs'},null,2));
