import {performance} from 'node:perf_hooks';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {WebSocket} from 'ws';
import {NotificationFanout} from '../src/moonraker/notifications.ts';
import {MoonrakerNetwork} from '../src/moonraker/server.ts';
import {JsonRpcDispatcher} from '../src/moonraker/rpc.ts';
const payload=[{toolhead:{position:[1.25,-0,3],exact:'9007199254740993'}},100.25],modes=['targeted','excludedBroadcast'] as const,typeSamples=()=>({targeted:[] as number[],excludedBroadcast:[] as number[]});
const model=typeSamples(),wire=typeSamples(),queue=new NotificationFanout();let authorized=0,received=0;
for(let id=1;id<=50;id++)queue.add(id,{signal:new AbortController().signal,authorize(){assert.equal(id,1);authorized++;},send:()=>{received++;return true;},disconnect(){throw new Error('Unexpected disconnect');}});
const excluded=Array.from({length:49},(_,i)=>i+2);
for(let run=0;run<54;run++)for(const mode of run%2?modes:[...modes].reverse()){const start=performance.now();for(let i=0;i<2000;i++){const r=await(mode==='targeted'?queue.publishTo(1,'notify_status_update',payload):queue.publish('notify_status_update',payload,excluded));assert.equal(r.sent,1);}if(run>=3)model[mode].push(performance.now()-start);}
assert.equal(authorized,216000);assert.equal(received,authorized);await queue.close();
const network=new MoonrakerNetwork(new JsonRpcDispatcher(),{authorize(){},authorizeNotification(_m,_p,c){assert.equal(c.connectionId,1);}}),address=await network.listen(),sockets:WebSocket[]=[];let count=0,complete:()=>void=()=>{};
try{for(let i=0;i<50;i++){const ws=new WebSocket(`ws://127.0.0.1:${address.port}/websocket`);sockets.push(ws);await once(ws,'open');ws.on('message',m=>{assert.equal(i,0);assert.deepEqual(JSON.parse(String(m)).params,JSON.parse(JSON.stringify(payload)));if(++count===500)complete();});}
 for(let run=0;run<54;run++)for(const mode of run%2?modes:[...modes].reverse()){count=0;let timer:ReturnType<typeof setTimeout>;const done=new Promise<void>((resolve,reject)=>{complete=resolve;timer=setTimeout(()=>reject(new Error('Receive timeout')),5000);});const start=performance.now();try{for(let i=0;i<500;i++){const r=await(mode==='targeted'?network.notifyAuthorized(1,'notify_status_update',payload):network.broadcast('notify_status_update',payload,excluded));assert.equal(r.sent,1);}await done;if(run>=3)wire[mode].push(performance.now()-start);}finally{clearTimeout(timer!);}}
}finally{for(const ws of sockets)ws.terminate();await network.close();}
const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[25],p95Ms:values[48]};};console.log(JSON.stringify({node:process.version,samples:51,connectedClients:50,modelPublications:2000,wirePublications:500,model:Object.fromEntries(modes.map(m=>[m,stats(model[m])])),wire:Object.fromEntries(modes.map(m=>[m,stats(wire[m])])),scope:'Alternating authorized single-recipient delivery versus existing authorized broadcast excluding 49 peers, same payload and queues; real wire waits for all 500 notifications. No Python unicast equivalence or printing deadline claim.'},null,2));
