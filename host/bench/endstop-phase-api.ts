import {performance} from 'node:perf_hooks';
import {EndstopPhaseAlignment} from '../src/homing/endstop-phase.ts';
import {registerNativeEndstopPhase} from '../src/moonraker/native-endstop-phase.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher,type RpcContext} from '../src/moonraker/rpc.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
const owners=['x','y','z'].map(name=>{const alignment=new EndstopPhaseAlignment({microsteps:256,stepDistance:.01});for(let i=0;i<1024;i++)alignment.observe(BigInt(i),0);return {name:'stepper_'+name,alignment};});
const registry=new EndpointRegistry(new JsonRpcDispatcher()),gate=new MaintenanceGate(),context:RpcContext={transport:'http',signal:new AbortController().signal,authorize(){}};
const close=registerNativeEndstopPhase(registry,gate,{idle:()=>true,snapshot:()=>({revision:'3072',steppers:owners.map(({name,alignment})=>{const stats=alignment.statistics!;return {name,primary:true,correction_enabled:false,trigger_phase:null,last_phase:1023,last_mcu_position:'1023',samples:String(stats.samples),calibration:{phase:stats.phase,phases:stats.phases,low:stats.low,high:stats.high,cost:String(stats.cost)}};})})});
const samples:number[]=[];let checksum=0;
try{for(let round=0;round<9;round++){const start=performance.now();for(let i=0;i<1000;i++){const result=await registry.invoke('/printer/calibration/endstop_phase','GET',{},context);checksum+=JSON.stringify(result).length;}const ms=performance.now()-start;if(round>=2)samples.push(ms);}samples.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,scope:'Authorized registry GET with cached exact statistics and JSON serialization for three 1024-bin axes; no network or MCU I/O',queries:1000,medianMs:samples[3],maxMs:samples.at(-1),samplesMs:samples,checksum},null,2));}finally{await close();}
