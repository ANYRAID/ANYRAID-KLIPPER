import assert from 'node:assert/strict';
import {nativeCarriageFixture} from '../test/helpers/native-carriage-port.ts';
import {registerNativeDualCarriage} from '../src/moonraker/native-dual-carriage.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher} from '../src/moonraker/rpc.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
const direct:number[]=[],api:number[]=[];
for(let round=0;round<6;round++)for(const useApi of (round%2?[true,false]:[false,true])){
 const f=await nativeCarriageFixture(),registry=new EndpointRegistry(new JsonRpcDispatcher()),gate=new MaintenanceGate();let synchronized=0;
 const signal=new AbortController().signal;
 const close=registerNativeDualCarriage(registry,gate,{
  snapshot:()=>{const s=f.port.carriageStatus!;return {generation:f.port.carriageGeneration,state:{primary:s.primary,homed:[...s.homed],carriages:s.carriages.map(c=>({...c})),position:[...f.port.homingPosition()]}};},
  idle:()=>!f.port.status.busy&&!f.port.status.pendingMoves,
  validate:(i,m)=>f.port.validateCarriageMode(i,m),
  set:async(i,m,s)=>{await f.port.setCarriageMode(i,m,s);synchronized++;},fail:e=>f.port.motorOff(e)
 });
 const invoke=(verb:string,params:any={})=>registry.invoke('/printer/settings/dual_carriage',verb,params,{transport:'http',signal,authorize(){}}) as Promise<any>;
 try{
  f.kinematics.markHomed([0,1,2]);const before=f.f.fw.motion.length,start=performance.now();
  if(useApi){const state=await invoke('GET'),request={version:1,state_token:state.state_token,carriage:1,mode:'PRIMARY'};const result=await invoke('POST',request);assert.deepEqual(await invoke('POST',request),result);assert.equal(synchronized,1);}
  else await f.port.setCarriageMode(1,'PRIMARY',signal);
  const elapsed=performance.now()-start;
  assert.equal(f.port.carriageStatus!.primary,1);assert.deepEqual(f.port.position(),[180,0,0,2]);assert.equal(f.f.fw.motion.length,before);
  f.kinematics.markHomed([0]);f.port.move([180.1,0,0,2],10);await f.port.drain(signal);
  const steps=f.f.fw.motion.filter(m=>m.name==='queue_step');assert.equal(steps.filter(m=>m.parameters.oid===3).length,0);assert.equal(steps.filter(m=>m.parameters.oid===5).reduce((n,m)=>n+Number(m.parameters.count),0),10);
  if(round)(useApi?api:direct).push(elapsed);
 }finally{await close();await f.close();}
}
console.log(JSON.stringify({runtime:process.version,scope:'Alternating native direct vs endpoint dispatch + GET + POST + accepted retry. Simulated MCU socket; excludes fixture startup and subsequent movement. Asserts no switch steps, one synchronization and exactly ten subsequent secondary-only steps. No HTTP transport or real hardware claim.',direct:{samplesMs:direct,medianMs:[...direct].sort((a,b)=>a-b)[2]},api:{samplesMs:api,medianMs:[...api].sort((a,b)=>a-b)[2]}},null,2));
