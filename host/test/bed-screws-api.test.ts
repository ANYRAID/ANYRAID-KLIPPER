import test from 'node:test';
import assert from 'node:assert/strict';
import {registerNativeBedScrews} from '../src/moonraker/native-bed-screws.ts';
import {readBedScrews} from '../src/config/bed-screws.ts';
import {linearMotionReader} from './helpers/linear-motion-config.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher} from '../src/moonraker/rpc.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
const configuration={screw1:'1,1',screw2:'2,1',screw3:'3,1',screw1_fine_adjust:'1,2',screw2_fine_adjust:'2,2',screw3_fine_adjust:'3,2'};
test('bed screw config validates fine points and gaps before motion',()=>{
 const read=(value:Record<string,string>)=>readBedScrews(linearMotionReader({bed_screws:value}));assert.equal(read(configuration)!.fine.length,3);
 for(const extra of [{screw1_fine_adjust:'53,0'},{probe_height:'6'},{screw5:'1,1'}] as Record<string,string>[])assert.throws(()=>read({...configuration,...extra}));
});
test('bed screw session holds lease, repeats adjusted points and reaches fine completion without replay',async()=>{
 const registry=new EndpointRegistry(new JsonRpcDispatcher()),gate=new MaintenanceGate(),plan=readBedScrews(linearMotionReader({bed_screws:configuration}))!;let p=[0,0,0,0],moves=0,stops=0;
 const close=registerNativeBedScrews(registry,gate,{idle:()=>true,planned:()=>p,limits:{axisMinimum:[0,0,0],axisMaximum:[52,200,200]},move:async target=>{p=[...target];moves++;},synchronize(){},stop:async()=>{stops++;},subscribeStop:()=>()=>{}},plan);
 const invoke=(verb:string,body:any={})=>registry.invoke('/printer/calibration/bed_screws',verb,body,{transport:'http',signal:new AbortController().signal,authorize(){}}) as Promise<any>;
 const act=async(action:string)=>{const body={version:1,state_token:(await invoke('GET')).state_token,action},value=await invoke('POST',body),count=moves;assert.deepEqual(await invoke('POST',body),value);assert.equal(moves,count);return value;};
 try{await act('start');assert(gate.status.maintenance);assert.throws(()=>gate.activity());await act('adjusted');assert.equal((await invoke('GET')).accepted_screws,0);for(let i=0;i<3;i++)await act('accept');assert.equal((await invoke('GET')).state,'fine');for(let i=0;i<3;i++)await act('accept');assert.equal((await invoke('GET')).phase,'completed');assert.equal(p[2],5);assert(!gate.status.maintenance);assert.equal(stops,0);await act('start');await act('cancel');assert.equal(stops,1);assert(gate.status.closed);assert.equal((await invoke('GET')).phase,'cancelled');}finally{await close();}
});
