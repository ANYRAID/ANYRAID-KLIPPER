import assert from 'node:assert/strict';
import {registerNativeProbe} from '../src/moonraker/native-probe.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher} from '../src/moonraker/rpc.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
const registry=new EndpointRegistry(new JsonRpcDispatcher()),gate=new MaintenanceGate(),context={transport:'http' as const,signal:new AbortController().signal,authorize:()=>{}};
let calls=0;const close=registerNativeProbe(registry,gate,{idle:()=>true,measure:async()=>{calls++;return {bed_position:[10,20,.123456789]};},synchronize:()=>{}});
const times:number[]=[];try{
 for(let i=0;i<1100;i++){
  const status=await registry.invoke('/printer/calibration/probe','GET',{},context) as any,request={version:1,state_token:status.state_token},start=performance.now();
  const first=await registry.invoke('/printer/calibration/probe','POST',request,context),repeat=await registry.invoke('/printer/calibration/probe','POST',request,context);assert.deepEqual(first,repeat);if(i>=100)times.push(performance.now()-start);
 }
 assert.equal(calls,1100);times.sort((a,b)=>a-b);assert(times[949]<10,'Probe receipt dispatch exceeded 10 ms P95');console.log(JSON.stringify({node:process.version,samples:times.length,p95Ms:times[949],medianMs:times[499],scope:'Authorized in-process endpoint, immediate fake measurement plus idempotent retry; no native motion or HTTP transport.'}));
}finally{await close();}
