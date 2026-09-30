import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeRequestScope} from '../src/moonraker/native-request-scope.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {ApiError,JsonRpcDispatcher,type RpcContext} from '../src/moonraker/rpc.ts';
import {NotificationFanout} from '../src/moonraker/notifications.ts';
const context=():RpcContext=>({transport:'http',signal:new AbortController().signal,authorize(){return {username:'operator'};}});
test('retirement aborts accepted handlers, drains ignored cancellation and retains process routes',async()=>{
 const scope=new NativeRequestScope(),registry=new EndpointRegistry(new JsonRpcDispatcher(),scope.wrap),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let signal:AbortSignal|undefined;
 registry.register({endpoint:'/printer/held',methods:['GET']},async(_p,_v,c)=>{signal=c.signal;assert.equal(c.user?.username,'operator');entered.resolve();await release.promise;return 'stale';});
 registry.register({endpoint:'/server/info',methods:['GET']},()=>({running:true}));
 const pending=registry.invoke('/printer/held','GET',{},context()),rejected=assert.rejects(pending,(e:unknown)=>e instanceof ApiError&&e.status===503);await entered.promise;
 let drained=false;const drain=scope.drain().then(()=>{drained=true;});assert.equal(signal?.aborted,true);
 try{await new Promise(r=>setImmediate(r));assert.equal(drained,false);assert.equal(scope.status.pending,1);await assert.rejects(registry.invoke('/printer/held','GET',{},context()),/retired/);assert.deepEqual(await registry.invoke('/server/info','GET',{},context()),{running:true});}
 finally{release.resolve();await rejected;await drain;}assert.equal(scope.status.pending,0);
});
for(const transport of ['http','websocket'] as const)test(`late ${transport} authorization cannot invoke a removed route after replacement`,async()=>{
 const rpc=new JsonRpcDispatcher(),registry=new EndpointRegistry(rpc),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let oldCalls=0,newCalls=0;
 const undo=registry.register({endpoint:'/printer/held',methods:['GET']},()=>{oldCalls++;return 'old';});
 const ctx:RpcContext={...context(),transport,async authorize(){entered.resolve();await release.promise;}};
 const pending=transport==='http'?registry.invoke('/printer/held','GET',{},ctx):rpc.dispatch(JSON.stringify({jsonrpc:'2.0',id:1,method:'printer.held'}),ctx);
 const check=transport==='http'?assert.rejects(pending,(e:unknown)=>e instanceof ApiError&&e.status===503):pending.then(value=>assert.equal(JSON.parse(value as string).error.code,503));
 await entered.promise;undo();registry.register({endpoint:'/printer/held',methods:['GET']},()=>{newCalls++;return 'new';});release.resolve();await check;
 assert.equal(oldCalls,0);assert.equal(newCalls,0);assert.equal(await registry.invoke('/printer/held','GET',{},context()),'new');
});
test('broadcast retirement suppresses held old status while the same connection receives disconnection',async()=>{
 const scope=new NativeRequestScope(),connection=new AbortController(),fanout=new NotificationFanout(),held=Promise.withResolvers<void>(),seen:string[]=[];let policySignal:AbortSignal|undefined;
 fanout.add(1,{signal:connection.signal,authorize(method,_params,signal){if(method==='notify_status_update'){policySignal=signal;return held.promise;}},send(encoded){seen.push(JSON.parse(encoded).method);return true;},disconnect(){assert.fail('Generation retirement must not disconnect the client');}});
 const old=fanout.dispatch('notify_status_update',[{toolhead:{position:[1,2,3]}}],[],scope.signal);scope.retire();assert.equal(policySignal?.aborted,true);
 const current=fanout.dispatch('notify_klippy_disconnected',[]);assert.equal(fanout.status.pending,2);
 try{held.resolve();assert.equal((await old).closed,1);assert.equal((await current).sent,1);assert.deepEqual(seen,['notify_klippy_disconnected']);assert.equal(connection.signal.aborted,false);}
 finally{held.resolve();await fanout.close();}
});
