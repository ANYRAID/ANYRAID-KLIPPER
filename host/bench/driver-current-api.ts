import {registerNativeDriverCurrent} from '../src/moonraker/native-driver-current.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher,type RpcContext} from '../src/moonraker/rpc.ts';
const gate=new MaintenanceGate(),registry=new EndpointRegistry(new JsonRpcDispatcher()),context:RpcContext={transport:'http',signal:new AbortController().signal,authorize(){}};
const drivers=['x','y','z','extruder'].map(name=>({name,revision:0,max_current:2,run_current:.8,hold_current:.3}));
const close=registerNativeDriverCurrent(registry,gate,{snapshot:()=>drivers,idle:()=>true,async set(){throw new Error('Read benchmark must not write');},fail(){throw new Error('Unexpected fault');}}),samples:number[]=[];
try{for(let batch=0;batch<9;batch++){const start=performance.now();for(let i=0;i<2000;i++)await registry.invoke('/printer/settings/driver_current','GET',{},context);if(batch>=2)samples.push(performance.now()-start);}samples.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,queries:2000,drivers:4,warmups:2,batches:7,medianMs:samples[3],maxMs:samples[6],scope:'Endpoint authorization, validation, revision fingerprint and snapshot; excludes HTTP transport and UART'},null,2));}finally{await close();}
