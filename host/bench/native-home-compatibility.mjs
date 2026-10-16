import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const [artifact,mode='candidate']=process.argv.slice(2);
if(!artifact||!['baseline','candidate'].includes(mode))throw Error('Expected compiled host directory and baseline/candidate');
const load=name=>import(pathToFileURL(resolve(artifact,'src',name+'.js')).href);
const [{EndpointRegistry},{JsonRpcDispatcher},{NativeRequestScope},{registerNativeProbe},{MaintenanceGate},{registerProductHostControl},{ProductHostControl}]=await Promise.all(['moonraker/endpoints','moonraker/rpc','moonraker/native-request-scope','moonraker/native-probe','operations/maintenance-gate','moonraker/product-host-api','runtime/product-host-control'].map(load));
const scope=new NativeRequestScope(),registry=new EndpointRegistry(new JsonRpcDispatcher(),scope.wrap),control=new ProductHostControl();let calls=0;
const release=registerProductHostControl(registry,control),close=registerNativeProbe(registry,new MaintenanceGate(),{idle:()=>true,measure:async(_signal,axes)=>{if(mode==='candidate')assert.deepEqual(axes,[0,1,2]);calls++;return {homed_axes:'xyz'};},synchronize(){}},'home');
const context={transport:'http',signal:new AbortController().signal,nativeGenerationSignal:scope.signal,authorize(){}},samples={typed:[],compatibility:[]},iterations=500;
try{
 for(let run=0;run<9;run++)for(const name of (mode==='baseline'?['typed']:run%2?['compatibility','typed']:['typed','compatibility'])){
  const start=performance.now(),before=calls;
  for(let i=0;i<iterations;i++){
   if(name==='typed'){const state=await registry.invoke('/printer/calibration/home','GET',{},context);await registry.invoke('/printer/calibration/home','POST',{version:1,state_token:state.state_token},context);}
   else assert.equal(await registry.invoke('/printer/gcode/script','POST',{script:'G28'},context),'ok');
  }
  assert.equal(calls-before,iterations);if(run>=2)samples[name].push(performance.now()-start);
 }
 const stats=values=>{const sorted=[...values].sort((a,b)=>a-b);return values.length?{rawMs:values,medianMs:sorted[3],maximumMs:sorted[6],medianUsPerOperation:sorted[3]*1000/iterations}:null;};
 console.log(JSON.stringify({node:process.version,mode,warmups:2,samples:7,iterations,typed:stats(samples.typed),compatibility:stats(samples.compatibility),scope:'Compiled package authorization, native generation, typed token and admission only; stub measurement. Not physical homing speed, print throughput or target-board latency.'}));
}finally{release();await close();await scope.drain();await control.close();}
