import test from 'node:test';
import assert from 'node:assert/strict';
import {readNativeHostStatus,type NativeHostSnapshot} from '../src/moonraker/native-host-status.ts';
import {ApiError,JsonRpcDispatcher} from '../src/moonraker/rpc.ts';
import {ServerInformation,ServerConfiguration,registerServerMetadata} from '../src/moonraker/metadata.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {MoonrakerNetwork} from '../src/moonraker/server.ts';
const snapshot=():NativeHostSnapshot=>({group_state:'ready',hardware_state:'ready',print_state:'idle',homed_axes:'',closing:false,admission_closed:false,maintenance:false,mcus:[{id:'mcu',state:'ready'},{id:'aux',state:'ready'}]});
test('native readiness describes configured owners, not homing or permission to start a print',()=>{
 const source=snapshot(),read=()=>readNativeHostStatus(()=>source),first=read();assert.equal(first.ready,true);assert.equal(first.homed_axes,'');first.mcus[0].state='closed';assert.equal(read().mcus[0].state,'ready');source.maintenance=true;assert.equal(read().maintenance,true);assert.equal(read().ready,true);
 for(const change of [{closing:true},{admission_closed:true},{group_state:'stopping'},{hardware_state:'failed'},{mcus:[{id:'mcu',state:'closed'}]}])assert.equal(readNativeHostStatus(()=>({...snapshot(),...change}) as NativeHostSnapshot).ready,false);
});
test('invalid or failed native sources report unavailable without cached readiness or private fault details',async()=>{
 for(const source of [()=>{throw new Error('/private/serial token');},()=>({...snapshot(),homed_axes:'xx'}),()=>({...snapshot(),print_state:'invented'}),()=>({...snapshot(),print_state:['idle']}),()=>({...snapshot(),print_state:new String('idle')}),()=>({...snapshot(),mcus:[{id:'mcu',state:'ready'},{id:'mcu',state:'ready'}]}),()=>({...snapshot(),mcus:[]}),()=>Promise.reject(new Error('async provider'))])assert.throws(()=>readNativeHostStatus(source as any),(e:unknown)=>e instanceof ApiError&&e.status===503&&!e.message.includes('private'));
 await new Promise(resolve=>setImmediate(resolve));const withPrivate={...snapshot(),fault:new Error('secret'),serial:'/private/device'};assert(!('fault' in readNativeHostStatus(()=>withPrivate)));assert(!('serial' in readNativeHostStatus(()=>withPrivate)));
});
test('authenticated metadata reads live native snapshots and leaves Klippy fields unchanged',async()=>{
 const rpc=new JsonRpcDispatcher(),registry=new EndpointRegistry(rpc),info=new ServerInformation({connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'test',missingRequirements:[]}),config=new ServerConfiguration({primaryFile:'/moonraker.conf',parsed:{},original:{},files:[]});let current=snapshot(),reads=0,fail=false;
 const detach=registerServerMetadata(registry,info,config,()=>0,()=>{reads++;if(fail)throw new Error('private failure');return current;});const service=new MoonrakerNetwork(rpc,{endpoints:registry,authorize:(_m,_p,c)=>{if(c.request.headers['x-api-key']!=='test')throw new ApiError(401,'Denied');}}),address=await service.listen(),url=`http://127.0.0.1:${address.port}/server/info`;
 try{
  let response=await fetch(url);assert.equal(response.status,401);await response.arrayBuffer();assert.equal(reads,0);
  response=await fetch(url,{headers:{'x-api-key':'test'}});let body:any=await response.json();assert.equal(body.result.klippy_connected,false);assert.equal(body.result.klippy_state,'disconnected');assert.equal(body.result.native_host.ready,true);assert.equal(reads,1);
  current={...current,group_state:'stopping',print_state:'failed'};response=await fetch(url,{headers:{'x-api-key':'test'}});body=await response.json();assert.equal(body.result.native_host.ready,false);assert.equal(body.result.native_host.print_state,'failed');
  fail=true;response=await fetch(url,{headers:{'x-api-key':'test'}});assert.equal(response.status,503);assert(!JSON.stringify(await response.json()).includes('private'));
 }finally{detach();await service.close();}
});
