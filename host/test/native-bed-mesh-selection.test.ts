import test from 'node:test';
import assert from 'node:assert/strict';
import {registerNativeBedMeshSelection} from '../src/moonraker/native-bed-mesh-selection.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher,type RpcContext} from '../src/moonraker/rpc.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {BedMeshProfiles} from '../src/motion/bed-mesh-profiles.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
const context:RpcContext={transport:'http',signal:new AbortController().signal,authorize(){}};
function fixture(){
 const profiles=new BedMeshProfiles(new ConfigurationReader(new ConfigurationSource('/mesh.cfg',{'bed_mesh saved':{version:'1',min_x:'0',max_x:'10',min_y:'0',max_y:'10',x_count:'2',y_count:'2',mesh_x_pps:'0',mesh_y_pps:'0',algo:'direct',tension:'.2',points:'.1,.2\n.3,.4'}},[]),null)),registry=new EndpointRegistry(new JsonRpcDispatcher()),gate=new MaintenanceGate();let revision={},profile='',calls=0,idle=true,fail=false,stops=0;
 const close=registerNativeBedMeshSelection(registry,gate,profiles,{snapshot:()=>({revision,profile}),idle:()=>idle,async set(mesh,name,s){s.throwIfAborted();calls++;if(fail)throw Error('switch failed');assert.equal(mesh===null,name==='');profile=name;revision={};},async fail(){stops++;}});
 const invoke=(verb:string,body:any={})=>registry.invoke('/printer/settings/bed_mesh',verb,body,context) as Promise<any>;
 return {close,gate,invoke,get calls(){return calls;},get stops(){return stops;},setIdle(v:boolean){idle=v;},external(){revision={};},fail(){fail=true;}};
}
test('mesh profile selection validates, deduplicates and detects external changes',async()=>{
 const f=fixture();try{let state=await f.invoke('GET');assert.deepEqual(state.profiles,['saved']);const request={version:1,state_token:state.state_token,action:'load',profile:'saved'};
  await assert.rejects(f.invoke('POST',{...request,profile:'missing'}),/Invalid/);f.setIdle(false);await assert.rejects(f.invoke('POST',request),/idle/);assert.equal(f.calls,0);f.setIdle(true);
  const receipt=await f.invoke('POST',request);assert.equal(receipt.profile,'saved');assert.deepEqual(await f.invoke('POST',request),receipt);assert.equal(f.calls,1);await assert.rejects(f.invoke('POST',{version:1,state_token:request.state_token,action:'clear'}),/conflicts/);
  state=await f.invoke('GET');f.external();await assert.rejects(f.invoke('POST',{version:1,state_token:state.state_token,action:'clear'}),/Stale/);state=await f.invoke('GET');assert.equal((await f.invoke('POST',{version:1,state_token:state.state_token,action:'clear'})).profile,'');assert.equal(f.calls,2);
 }finally{await f.close();}
});
test('failed mesh selection invalidates generation and stops motion',async()=>{const f=fixture();try{const state=await f.invoke('GET');f.fail();await assert.rejects(f.invoke('POST',{version:1,state_token:state.state_token,action:'load',profile:'saved'}),/reinitialize/);assert(f.gate.status.closed);assert.equal(f.stops,1);assert.equal((await f.invoke('GET')).available,false);}finally{await f.close();}});
