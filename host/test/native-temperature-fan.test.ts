import test from 'node:test';
import assert from 'node:assert/strict';
import {registerNativeTemperatureFans} from '../src/moonraker/native-temperature-fan.ts';
import {TemperatureFanControl} from '../src/thermal/temperature-fan.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher,type RpcContext} from '../src/moonraker/rpc.ts';
const path='/printer/settings/temperature_fan',name='temperature_fan chamber';
function fixture(){
 const control=new TemperatureFanControl({minimumTemperature:0,maximumTemperature:100,target:40,minimumSpeed:.3,maximumSpeed:1},{kind:'watermark',delta:2},.3),registry=new EndpointRegistry(new JsonRpcDispatcher());
 let available=true;const context:RpcContext={transport:'http',signal:new AbortController().signal,authorize:()=>{}};
 const bind=()=>registerNativeTemperatureFans(registry,[{section:name,control}],()=>available);
 return {control,registry,context,bind,setAvailable(v:boolean){available=v;},invoke:(verb:string,params:any={name})=>registry.invoke(path,verb,params,context) as Promise<any>};
}
test('fan settings authorize before mutation, atomically validate and retry without resetting target',async()=>{
 const f=fixture(),close=f.bind();try{
  const initial=await f.invoke('GET'),request={name,version:1,state_token:initial.state_token,target:50,min_speed:.2,max_speed:.6};
  await assert.rejects(f.registry.invoke(path,'POST',request,{...f.context,authorize(){throw new Error('denied');}}),/denied/);assert.equal(f.control.settings.target,40);
  for(const update of [{target:200},{min_speed:.9},{target:null},{target:'50'},{max_speed:NaN},{unknown:true}]){await assert.rejects(f.invoke('POST',{...request,...update}));assert.equal(f.control.settings.target,40);}
  const receipt=await f.invoke('POST',request);assert.equal(receipt.target,50);assert.equal(receipt.persisted,false);assert.equal(receipt.applies_to,'next_temperature_sample');
  assert.deepEqual(await f.invoke('POST',request),receipt);await assert.rejects(f.invoke('POST',{...request,target:51}),/conflicts/);
  const next=await f.invoke('POST',{name,version:1,state_token:receipt.state_token,max_speed:.5});assert.equal(next.target,50);assert.equal(next.min_speed,.2);
  await assert.rejects(f.invoke('POST',request),/Stale/);assert.equal((await f.invoke('GET',{})).fans.length,1);
 }finally{close();}
});
test('external updates, maintenance, reload and delayed authorization cannot reuse stale setting authority',async()=>{
 const f=fixture();let close=f.bind();try{
  const state=await f.invoke('GET'),request={name,version:1,state_token:state.state_token,target:50};
  f.control.configure({target:45});f.control.configure({target:40});await assert.rejects(f.invoke('POST',request),/Stale/);f.control.configure({target:45});
  const latest=await f.invoke('GET');f.setAvailable(false);await assert.rejects(f.invoke('POST',{...request,state_token:latest.state_token}),/unavailable/);f.setAvailable(true);
  let release!:()=>void;const authorized=new Promise<void>(r=>{release=r;});
  const pending=f.registry.invoke(path,'POST',{...request,state_token:latest.state_token},{...f.context,authorize:()=>authorized});close();release();await assert.rejects(pending,/unavailable/);
  close=f.bind();await assert.rejects(f.invoke('POST',{...request,state_token:latest.state_token}),/Stale/);assert.equal(f.control.settings.target,45);
 }finally{close();}
});
