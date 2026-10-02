import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {registerManualProbe} from '../src/moonraker/native-manual-probe.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher,type RpcContext} from '../src/moonraker/rpc.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
const path='/printer/calibration/manual_probe',context:RpcContext={transport:'http',signal:new AbortController().signal,authorize(){}};
function fixture(timeout=300000){
 const gate=new MaintenanceGate(),registry=new EndpointRegistry(new JsonRpcDispatcher()),moves:number[][]=[];let p=[2,3,1,4],idle=true,stops=0;
 let listener:(cause:unknown)=>void=()=>{};
 const close=registerManualProbe(registry,gate,{idle:()=>idle,planned:()=>[...p],measured:()=>p.map(v=>Math.round(v*100)/100),limits:{axisMinimum:[0,0,0],axisMaximum:[10,10,10]},move:async(target,speed,s)=>{s.throwIfAborted();assert(speed<=5);p=[...target];moves.push(p);},synchronize(){},stop:async c=>{stops++;listener(c);},subscribeStop:l=>{listener=l;return ()=>{listener=()=>{};};}},timeout);
 const get=()=>registry.invoke(path,'GET',{},context) as Promise<any>,post=(body:any)=>registry.invoke(path,'POST',body,context) as Promise<any>,act=async(action:string,extra={})=>post({version:1,state_token:(await get()).state_token,action,...extra});
 return {gate,registry,moves,close,get,post,act,setIdle(v:boolean){idle=v;},externalStop(){listener(Error('MCU fault'));},get stops(){return stops;}};
}
test('standalone contact uses current XY, no startup/retract move, measured Z and retry receipts',async()=>{
 const f=fixture();try{
  assert.equal((await f.get()).point,null);f.setIdle(false);await assert.rejects(f.act('start'),/idle homed/);f.setIdle(true);
  const first=await f.act('start');assert.deepEqual(first.point,[2,3]);assert.equal(f.moves.length,0);assert(f.gate.status.maintenance);assert.throws(()=>f.gate.activity());
  await assert.rejects(f.act('accept'),/Lower/);await assert.rejects(f.act('adjust',{delta:-2}),/limits/);assert.equal(f.moves.length,0);
  const tiny=await f.act('adjust',{delta:-1e-6});assert(tiny.unchanged);await assert.rejects(f.act('accept'),/Lower/);
  await f.act('adjust',{delta:-.101});const request={version:1,state_token:(await f.get()).state_token,action:'accept'},count=f.moves.length,done=await f.post(request);
  assert.equal(done.state,'completed');assert.deepEqual(done.result,{position:[2,3,.9],persisted:false});assert.equal(f.moves.length,count);assert.deepEqual(await f.post(request),done);assert.equal(f.moves.length,count);assert(!f.gate.status.maintenance);
  await assert.rejects(f.post({...request,action:'start'}),/conflicts/);assert(f.moves.every(p=>p[0]===2&&p[1]===3&&p[3]===4));
  const again=await f.act('start');assert.equal(again.state,'awaiting');assert.equal(again.accepted.length,0);assert.equal(f.moves.length,count);
 }finally{await f.close();}
});
for(const mode of ['cancel','timeout','hardware','close'] as const)test(`standalone contact releases admission and stops on ${mode}`,async()=>{
 const f=fixture(mode==='timeout'?25:300000);try{
  await f.act('start');if(mode==='cancel')await f.act('cancel');else if(mode==='timeout')await delay(50);else if(mode==='hardware'){f.externalStop();await delay(0);}else await f.close();
  assert.equal(f.stops,1);assert(f.gate.status.closed);assert(!f.gate.status.maintenance);assert.equal(f.moves.length,0);
 }finally{await f.close();}
});
test('standalone probing honors endpoint authorization before taking motion ownership',async()=>{
 const f=fixture();try{await assert.rejects(f.registry.invoke(path,'POST',{version:1,state_token:(await f.get()).state_token,action:'start'},{...context,authorize(){throw Error('denied');}}),/denied/);assert(!f.gate.status.maintenance);assert.equal(f.moves.length,0);}finally{await f.close();}
});
