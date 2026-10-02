import test from 'node:test';
import assert from 'node:assert/strict';
import {GCodeMove} from '../src/gcode/move.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
import {ObjectCommands} from '../src/gcode/object-commands.ts';
import {registerNativeObjectCancellation} from '../src/moonraker/native-object-cancel.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher,type RpcContext} from '../src/moonraker/rpc.ts';
const path='/printer/print/objects',context:RpcContext={transport:'http',signal:new AbortController().signal,authorize(){}};
test('typed cancellation works while dispatch is retained and rejects stale, conflicting and unknown requests',async()=>{
 const registry=new EndpointRegistry(new JsonRpcDispatcher()),port={position:()=>[0,0,0,0],move(){}},objects=new ObjectCommands(new GCodeMove(port),port),dispatch=new GCodeDispatch({output(){},shutdown(){}});
 objects.register(dispatch);dispatch.setReady(true);await dispatch.execute('EXCLUDE_OBJECT_DEFINE NAME=A\nEXCLUDE_OBJECT_DEFINE NAME=B');
 let state='printing',stateToken='one',active=true;const close=registerNativeObjectCancellation(registry,objects,{snapshot:()=>({requestId:'job',state,stateToken,available:active}),assertActive(){assert(active);}}),get=()=>registry.invoke(path,'GET',{},context) as Promise<any>,post=(p:any)=>registry.invoke(path,'POST',p,context) as Promise<any>;
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();dispatch.register('WAIT',async()=>{entered.resolve();await release.promise;});const pending=dispatch.execute('WAIT');await entered.promise;
 try{
  const body={version:1,state_token:(await get()).state_token,name:'A'},receipt=await post(body);assert.deepEqual(receipt.excluded_objects,['A']);assert.deepEqual(await post(body),receipt);await assert.rejects(post({...body,name:'B'}),/conflicts/);
  state='paused';stateToken='two';await assert.rejects(post(body),/Stale/);const paused=await get();await assert.rejects(post({version:1,state_token:paused.state_token,name:'C'}),/Unknown/);await post({version:1,state_token:paused.state_token,name:'B'});assert.deepEqual(objects.status.excluded_objects,['A','B']);
  const before=await get();objects.reset();objects.exclude('A');objects.exclude('B');await assert.rejects(post({version:1,state_token:before.state_token,name:'A'}),/Stale/);
  state='finishing';stateToken='three';await assert.rejects(post({version:1,state_token:(await get()).state_token,name:'A'}),/active print/);
  active=false;assert.equal((await get()).available,false);
 }finally{release.resolve();await pending;close();}await assert.rejects(get(),/Not Found/);
});
