import test from 'node:test';
import assert from 'node:assert/strict';
import {GCodeMove} from '../src/gcode/move.ts';
import {registerNativeZAdjustment} from '../src/moonraker/native-z-adjustment.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher,type RpcContext} from '../src/moonraker/rpc.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
const path='/printer/calibration/z_offset',context:RpcContext={transport:'http',signal:new AbortController().signal,authorize(){}};
function fixture(){
 const gate=new MaintenanceGate(),registry=new EndpointRegistry(new JsonRpcDispatcher());let position=[10,20,1,4],moves=0,stops=0,idle=true,printToken='idle';
 const coordinates=new GCodeMove({position:()=>position,move(p,speed){assert.equal(speed,5);position=[...p];moves++;}});
 const port={snapshot:()=>({offset:coordinates.zOffset.value,revision:coordinates.zOffset.revision,position:coordinates.state.position,printToken,minimum:0,maximum:10}),idle:()=>idle,async adjust(delta:number,signal:AbortSignal){signal.throwIfAborted();coordinates.execute('SET_GCODE_OFFSET',{Z_ADJUST:delta,MOVE:1,MOVE_SPEED:5});},async stop(){stops++;}};
 const close=registerNativeZAdjustment(registry,gate,port),get=()=>registry.invoke(path,'GET',{},context) as Promise<any>,post=(p:any,c=context)=>registry.invoke(path,'POST',p,c) as Promise<any>;
 return {gate,coordinates,port,close,get,post,get moves(){return moves;},get stops(){return stops;},setIdle(value:boolean){idle=value;},changePrint(){printToken+='x';}};
}
test('typed adjustment moves only Z, preserves logical position, and retries without another move',async()=>{
 const f=fixture();try{
  const before=f.coordinates.gcodePosition,body={version:1,state_token:(await f.get()).state_token,adjust:-.025};const receipt=await f.post(body);
  assert.equal(receipt.z_offset,-.025);assert.deepEqual(receipt.position,[10,20,.975,4]);assert.deepEqual(f.coordinates.gcodePosition,before);assert.equal(receipt.persisted,false);assert.equal(receipt.available,true);
  assert.deepEqual(await f.post(body),receipt);assert.equal(f.moves,1);await assert.rejects(f.post({...body,adjust:.025}),/conflicts/);
  f.changePrint();await assert.rejects(f.post(body),/Stale/);assert.equal(f.moves,1);
 }finally{await f.close();}
});
test('invalid, unauthorized, nonidle and competing operations never move',async()=>{
 const f=fixture();try{
  const body={version:1,state_token:(await f.get()).state_token,adjust:.025};
  for(const adjust of [0,.10001,-.10001,NaN,Infinity,'0.01'])await assert.rejects(f.post({...body,adjust}),/Expected|Non-JSON/);
  await assert.rejects(f.post({...body,MOVE:1}),/Expected/);await assert.rejects(f.post(body,{...context,authorize(){throw Error('denied');}}),/denied/);
  f.setIdle(false);await assert.rejects(f.post(body),/idle homed/);f.setIdle(true);
  const release=f.gate.activity();await assert.rejects(f.post(body),/idle homed/);release();
  f.coordinates.execute('SET_GCODE_OFFSET',{Z:1});await assert.rejects(f.post(body),/Stale/);
  f.port.snapshot=()=>({offset:1,revision:'1',position:[10,20,0,4],printToken:'idle',minimum:0,maximum:10});await assert.rejects(f.post({...body,state_token:(await f.get()).state_token,adjust:-.01}),/travel limits/);
  assert.equal(f.moves,0);assert.equal(f.stops,0);
 }finally{await f.close();}
});
for(const reason of ['failure','close','cancel'])test(`adjustment ${reason} fences printer and joins stop`,async()=>{
 const f=fixture(),controller=new AbortController();try{
  const entered=Promise.withResolvers<void>();f.port.adjust=async(_delta,signal)=>{entered.resolve();if(reason==='failure')throw Error('motion failure');await new Promise<void>((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});signal.throwIfAborted();});};
  const request=f.post({version:1,state_token:(await f.get()).state_token,adjust:.01},{...context,signal:controller.signal}),failed=assert.rejects(request,/reinitialize/);await entered.promise;
  assert(f.gate.status.maintenance);if(reason==='close')await f.close();if(reason==='cancel')controller.abort();await failed;
  assert.equal(f.stops,1);assert(f.gate.status.closed);assert(!f.gate.status.maintenance);
 }finally{await f.close();}
});
