import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {registerNativeDeltaCalibration} from '../src/moonraker/native-delta-calibration.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher,type RpcContext} from '../src/moonraker/rpc.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {asymmetricDeltaCalibration} from '../test/helpers/delta-calibration.ts';

const baseline=process.argv[2];assert(baseline,'Pass the frozen pre-change native-delta-calibration.ts module path');
const previous=(await import(pathToFileURL(baseline).href)).registerNativeDeltaCalibration as typeof registerNativeDeltaCalibration;
const endpoint='/printer/calibration/delta',context:RpcContext={transport:'http',signal:new AbortController().signal,authorize(){}};
const iterations=5000,warmups=1,samples=9,maximumRatio=1.5;
const median=(values:number[])=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
async function fixture(register:typeof registerNativeDeltaCalibration,state:'ready'|'candidate'|'failed'){
 const registry=new EndpointRegistry(new JsonRpcDispatcher()),gate=new MaintenanceGate(),motion={idle:()=>true,synchronize(){},measure:async()=>{if(state==='failed')throw new Error('fixed failed measurement');return asymmetricDeltaCalibration()[1];}};
 const close=register(registry,gate,motion),get=()=>registry.invoke(endpoint,'GET',{},context);
 if(state!=='ready'){
  const token=(await get() as {state_token:string}).state_token;
  const action=registry.invoke(endpoint,'POST',{version:1,state_token:token,action:'calibrate'},context);
  if(state==='failed')await assert.rejects(action,/Delta calibration failed/);else await action;
 }
 return {close,get};
}
const results=[];
for(const state of ['ready','candidate','failed'] as const){
 const old=await fixture(previous,state),current=await fixture(registerNativeDeltaCalibration,state),oldUs:number[]=[],newUs:number[]=[];
 try{
  assert.deepEqual({...await old.get() as object,state_token:''},{...await current.get() as object,state_token:''});
  for(let sample=0;sample<warmups+samples;sample++)for(const mode of sample%2?['new','old']:['old','new']){
   const owner=mode==='old'?old:current,start=performance.now();
   for(let i=0;i<iterations;i++)await owner.get();
   if(sample>=warmups)(mode==='old'?oldUs:newUs).push((performance.now()-start)*1000/iterations);
  }
  const oldMedianUs=median(oldUs),newMedianUs=median(newUs),ratio=newMedianUs/oldMedianUs;
  results.push({state,oldUs,newUs,oldMedianUs,newMedianUs,ratio,passed:ratio<=maximumRatio});
 }finally{await old.close();await current.close();}
}
const report={node:process.version,baseline,warmups,samples,iterations,maximumRatio,results,passed:results.every(r=>r.passed),scope:'Alternating local authorized registry GET cost with ready, fitted candidate and failed owners. Diagnostic copies are not called by GET, HTTP or step generation. The 50% median regression budget is fixed before measurement. Excludes HTTP/network, target board and actual printer performance.'};
console.log(JSON.stringify(report,null,2));assert(report.passed,'Delta diagnostic GET regression budget exceeded');
