import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';
import {ClientCalls,encodeClientCall} from '../src/moonraker/client-calls.ts';
import {MoonrakerNetwork} from '../src/moonraker/server.ts';
import {JsonRpcDispatcher} from '../src/moonraker/rpc.ts';
async function until(fn:()=>boolean){for(let i=0;i<500;i++){if(fn())return;await delay(2);}throw new Error('Condition timed out');}
test('client calls encode object/list arguments without IDs, omit empty arguments and preserve float intent',()=>{
 for(const args of [null,[],{}])assert.deepEqual(JSON.parse(encodeClientCall('agent.run',args)),{jsonrpc:'2.0',method:'agent.run'});
 assert.deepEqual(JSON.parse(encodeClientCall('agent.run',{text:'中文',n:'9007199254740993'})),{jsonrpc:'2.0',method:'agent.run',params:{text:'中文',n:'9007199254740993'}});
 assert.match(encodeClientCall('agent.run',[1e20]),/1e\+20/);
 assert.throws(()=>encodeClientCall('',null));assert.throws(()=>encodeClientCall('x\0y',null));assert.throws(()=>encodeClientCall('x',{n:NaN}));
});
test('client call queue freezes exact wire arguments, isolates slow recipients and drains ignored cancellation',async()=>{
 const queue=new ClientCalls({perClient:2}),sent:string[]=[],owner=new AbortController();let release!:()=>void,closed=false;
 const gate=new Promise<void>(r=>release=r);
 queue.add(1,{signal:owner.signal,authorize(_m,p){assert.ok(Object.isFrozen(p));assert.deepEqual(p,{position:[1,2,3]});assert.ok(Object.isFrozen((p as any).position));return gate;},send(){throw new Error('Disconnected owner must not receive');},disconnect(){}});
 queue.add(2,{signal:new AbortController().signal,authorize(){},send:s=>{sent.push(s);return true;},disconnect(){}});
 const args={position:[1,2,3]},first=queue.dispatchTo(1,'move_result',args);args.position[0]=9;
 assert.equal((await queue.dispatchTo(2,'move_result',{ok:true})).sent,1);assert.equal(sent.length,1);
 owner.abort();assert.equal(queue.status.pending,1);const closing=queue.close().then(()=>closed=true);await delay(2);assert.equal(closed,false);
 release();await closing;assert.equal((await first).closed,1);assert.equal(queue.status.pending,0);assert.equal(queue.status.bytes,0);
});
test('live client calls require their own policy, carry no reply ID and release capacity without a reply',async()=>{
 const rpc=new JsonRpcDispatcher(),checked:any[]=[],network=new MoonrakerNetwork(rpc,{authorize(){},authorizeClientCall(m,p,c){checked.push([m,p,c.connectionId,c.request.headers['x-agent']]);if(m==='denied')throw new Error('denied');}});
 const address=await network.listen(),socket=new WebSocket(`ws://127.0.0.1:${address.port}/websocket`,{headers:{'x-agent':'worker'}});
 try{await once(socket,'open');const messages:any[]=[];socket.on('message',v=>messages.push(JSON.parse(String(v))));socket.send(JSON.stringify({jsonrpc:'2.0',method:'server.websocket.id',id:1}));await until(()=>messages.length===1);const id=messages[0].result.websocket_id;
 assert.equal((await network.dispatchClientCall(id,'agent.result',{x:1})).sent,1);await until(()=>messages.length===2);
 assert.deepEqual(messages[1],{jsonrpc:'2.0',method:'agent.result',params:{x:1}});assert.equal(network.status.clientCalls?.pending,0);assert.equal(network.status.clientRequests,null);
 assert.equal((await network.dispatchClientCall(id,'denied',null)).denied,1);assert.deepEqual(checked[0],['agent.result',{x:1},id,'worker']);assert.equal(messages.length,2);
 }finally{socket.terminate();await network.close();}
 const absent=new MoonrakerNetwork(new JsonRpcDispatcher(),{authorize(){},authorizeClientRequest(){},authorizeNotification(){}});
 try{await absent.listen();assert.throws(()=>absent.dispatchClientCall(1,'agent.result',{}),/authorization/);}finally{await absent.close();}
});
