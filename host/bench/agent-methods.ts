import {createServer,type Socket} from 'node:net';
import {once} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {WebSocket} from 'ws';
import assert from 'node:assert/strict';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
import {KlippyLifecycle} from '../src/moonraker/klippy-lifecycle.ts';
import {MoonrakerNetwork} from '../src/moonraker/server.ts';
import {JsonRpcDispatcher} from '../src/moonraker/rpc.ts';
const wire=(v:unknown)=>JSON.stringify(v)+'\x03',root=await mkdtemp(join(tmpdir(),'agent-wire-')),payload={position:[1.25,2,3],exact:'9007199254740993',text:'中文'};
async function setup(mode:'bridge'|'manual'|'queued'){
 const path=join(root,mode+'.sock');let klippy!:Socket,callback='',count=0,complete:()=>void=()=>{};
 const peer=createServer(socket=>{klippy=socket;let buffer='';socket.on('data',data=>{buffer+=data.toString();for(let at;(at=buffer.indexOf('\x03'))>=0;){const m=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);let result:any={};switch(m.method){case 'info':result={state:'ready'};break;case 'list_endpoints':result={endpoints:['objects/subscribe','objects/list','register_remote_method']};break;case 'objects/list':result={objects:['virtual_sdcard','display_status','pause_resume']};break;case 'objects/subscribe':result={eventtime:0,status:{webhooks:{state:'ready'}}};break;case 'register_remote_method':callback=m.params.response_template.method;break;}socket.write(wire({id:m.id,result}));}});});await new Promise<void>(r=>peer.listen(path,r));
 let service:ConfiguredMoonraker|MoonrakerNetwork,runtime:KlippyLifecycle|undefined,address:{port:number};
 if(mode!=='manual'){const config=join(root,mode+'.conf');await writeFile(config,'[server]\nhost=127.0.0.1\nport=0');service=await ConfiguredMoonraker.load(config,{information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'bench',missingRequirements:[]},authorize(){},authorizeClientCall(){}});address=await service.start();if(mode==='bridge')await service.attachKlippy(path);}else{service=new MoonrakerNetwork(new JsonRpcDispatcher(),{authorize(){},authorizeClientCall(){}});address=await service.listen();runtime=new KlippyLifecycle({version:'bench'});await runtime.initialize(path);}
 const ws=new WebSocket(`ws://127.0.0.1:${address.port}/websocket`);await once(ws,'open');let next=1;const replies=new Map<number,(v:any)=>void>();
 ws.on('message',message=>{const v=JSON.parse(String(message));if(v.id!==undefined){replies.get(v.id)?.(v);replies.delete(v.id);return;}assert.equal(v.method,'agent.report');assert.deepEqual(v.params,payload);if(++count===1000)complete();});
 async function rpc(method:string,params:object){const id=next++;let timer:ReturnType<typeof setTimeout>;try{return await new Promise<any>((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('RPC timeout')),5000);replies.set(id,resolve);ws.send(JSON.stringify({jsonrpc:'2.0',method,params,id}));});}finally{clearTimeout(timer!);replies.delete(id);}}
 const identified=await rpc('server.connection.identify',{client_name:'bench',type:'agent',version:'1',url:''});assert.ok(identified.result);const id=identified.result.connection_id;
 if(service instanceof ConfiguredMoonraker){assert.equal((await rpc('server.connection.register_remote_method',{method_name:'agent.report'})).result,'ok');if(mode==='queued')await service.attachKlippy(path);}else{const network=service;await runtime!.registerLiveRemoteMethod('agent.report',(p,signal)=>{const result=network.dispatchClientCall(id,'agent.report',p,signal);if('then' in result)void result.catch(()=>{});},network.connectionSignal(id));}
 assert.ok(callback);
 return {async sample(){count=0;let timer:ReturnType<typeof setTimeout>;const done=new Promise<void>((resolve,reject)=>{complete=resolve;timer=setTimeout(()=>reject(new Error('Callback timeout')),5000);}),start=performance.now();try{for(let i=0;i<1000;i++)klippy.write(wire({method:callback,params:payload}));await done;return performance.now()-start;}finally{clearTimeout(timer!);}},async close(){ws.terminate();await service.close();await runtime?.close();klippy.destroy();await new Promise<void>(r=>peer.close(()=>r()));}};
}
const services={bridge:await setup('bridge'),manual:await setup('manual'),queued:await setup('queued')},samples={bridge:[] as number[],manual:[] as number[],queued:[] as number[]};
try{for(let run=0;run<54;run++)for(const mode of (run%2?['bridge','manual','queued']:['queued','manual','bridge']) as ('bridge'|'manual'|'queued')[]){const time=await services[mode].sample();if(run>=3)samples[mode].push(time);}}finally{for(const service of Object.values(services))await service.close();await rm(root,{recursive:true,force:true});}
console.log(JSON.stringify({node:process.version,warmup:3,samples:51,deliveries:1000,results:Object.fromEntries(Object.entries(samples).map(([mode,times])=>{times.sort((a,b)=>a-b);return [mode,{medianMs:times[25],p95Ms:times[48]}];})),scope:'Actual Unix Klippy callbacks to actual WebSocket agent, all 1000 consumed. Live and pre-start public registration vs manual same authorized generation-scoped forwarding. No Python daemon or physical printer speed equivalence claim.'},null,2));
