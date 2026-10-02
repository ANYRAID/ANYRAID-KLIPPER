import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as turn} from 'node:timers/promises';
import {MqttStatusPublisher,readMqttStatusOptions} from '../src/moonraker/mqtt-status.ts';
import {prepareStatus} from '../src/moonraker/subscription-status.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
const config=(mqtt:Record<string,string>)=>new ConfigurationReader(new ConfigurationSource('/config/main.conf',{DEFAULT:{},server:{},mqtt},[]));
test('MQTT status config preserves empty/all fields and validates explicit interval',()=>{
 assert.deepEqual(readMqttStatusOptions(config({})),{objects:{},split:false,interval:0});
 assert.deepEqual(readMqttStatusOptions(config({status_objects:'toolhead=position,velocity\nwebhooks\nempty=',publish_split_status:'yes',status_interval:'.5'})),{objects:{toolhead:['position','velocity'],webhooks:null,empty:[]},split:true,interval:.5});
 for(const interval of ['0','.25','-1','nan'])assert.throws(()=>readMqttStatusOptions(config({status_interval:interval})),/Invalid status/);
});
test('MQTT status combines selected fields with last event time and emits retained split values',async()=>{
 for(const split of [false,true]){
  const frames:any[]=[];const publisher=new MqttStatusPublisher({async publish(topic,payload,options){frames.push({topic,payload:JSON.parse(payload),retain:options.retain});}},'printer',{objects:{toolhead:['position','velocity'],webhooks:null},split,interval:1},()=>true);
  publisher.send(prepareStatus({toolhead:{position:[1.25,2,3],secret:'omit'},webhooks:{state:'ready'}}),1.5);
  publisher.send(prepareStatus({toolhead:{velocity:120,position:[2.25,2,3]},ignored:{x:1}}),2.5);assert.equal(frames.length,0);publisher.flush();await turn();
  assert.deepEqual(frames,split?[
   {topic:'printer/klipper/state/toolhead/position',payload:{eventtime:2.5,value:[2.25,2,3]},retain:true},
   {topic:'printer/klipper/state/toolhead/velocity',payload:{eventtime:2.5,value:120},retain:true},
   {topic:'printer/klipper/state/webhooks/state',payload:{eventtime:2.5,value:'ready'},retain:true},
  ]:[{topic:'printer/klipper/status',payload:{eventtime:2.5,status:{toolhead:{position:[2.25,2,3],velocity:120},webhooks:{state:'ready'}}},retain:false}]);await publisher.close();
 }
});
test('Slow MQTT coalesces a bounded pending batch and contains failure without awaiting in caller',async()=>{
 const frames:any[]=[];let release:()=>void=()=>{};
 const publisher=new MqttStatusPublisher({publish(_topic,payload){frames.push(JSON.parse(payload));return frames.length===1?new Promise<void>(r=>release=r):Promise.resolve();}},'p',{objects:{toolhead:null},split:false,interval:0},()=>true);
 publisher.send(prepareStatus({toolhead:{velocity:1}}),1);
 for(let i=2;i<=1000;i++)publisher.send(prepareStatus({toolhead:{velocity:i}}),i);
 assert.equal(frames.length,1);assert.ok(publisher.status.pendingBytes<100);assert.equal(publisher.status.coalesced,998);
 publisher.send(prepareStatus({toolhead:{blob:'x'.repeat(65536)}}),1001);assert.equal(publisher.status.rejected,1);
 release();await turn();assert.equal(frames.length,2);assert.deepEqual(frames[1],{eventtime:1000,status:{toolhead:{velocity:1000}}});await publisher.close();
 const failing=new MqttStatusPublisher({publish(){throw new Error('private broker failure');}},'p',{objects:{webhooks:null},split:false,interval:0},()=>true);
 failing.send(prepareStatus({webhooks:{state:'ready'}}),1);await turn();assert.equal(failing.status.failed,1);await failing.close();
});
test('MQTT broker epochs and Klippy reset discard stale timed status and cancel active split batches',async()=>{
 let epoch=1;const frames:string[]=[];
 const publisher=new MqttStatusPublisher({async publish(_topic,payload){frames.push(payload);}},'p',{objects:{x:null},split:false,interval:1},()=>true,()=>epoch);
 publisher.send(prepareStatus({x:{old:1}}),1);epoch++;publisher.flush();await turn();assert.equal(frames.length,0);
 publisher.send(prepareStatus({x:{new:2}}),2);publisher.reset();publisher.flush();await turn();assert.equal(frames.length,0);await publisher.close();
 let calls=0;const split=new MqttStatusPublisher({publish(_topic,_payload,{signal}){calls++;return new Promise<void>((_r,reject)=>signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true}));}},'p',{objects:{x:null},split:true,interval:0},()=>true);
 split.send(prepareStatus({x:{a:1,b:2}}),1);await split.close();assert.equal(calls,1);assert.equal(split.status.active,false);
});
test('MQTT interval timer publishes and close stops subsequent emissions',async()=>{
 const frames:string[]=[];const publisher=new MqttStatusPublisher({async publish(_topic,payload){frames.push(payload);}},'p',{objects:{x:null},split:false,interval:.251},()=>true);
 publisher.start();publisher.send(prepareStatus({x:{value:3}}),42);await new Promise(r=>setTimeout(r,300));assert.equal(frames.length,1);assert.equal(JSON.parse(frames[0]).eventtime,42);await publisher.close();publisher.send(prepareStatus({x:{value:4}}),43);assert.equal(frames.length,1);
});
test('MQTT status payloads match executed pinned Moonraker methods including timed merge',async()=>{
 const {spawnSync}=await import('node:child_process');const {mqttStatusOracle}=await import('./helpers/mqtt-status-oracle.ts');
 const updates=[{toolhead:{position:[1.25,2,3],velocity:42},webhooks:{state:'ready'}},{toolhead:{velocity:88},webhooks:{state_message:'打印'}}];
 const child=spawnSync('python3',['-c',mqttStatusOracle()+`\nupdates=json.loads(${JSON.stringify(JSON.stringify(updates))})\nresults=[]\nfor split in [False,True]:\n for interval in [0,1]:\n  obj=reference(split,interval)\n  for i,status in enumerate(updates):obj.send_status(status,i+0.125)\n  obj._handle_timed_status_update(99)\n  results.append(obj.frames)\nprint(json.dumps(results))`],{encoding:'utf8'});assert.equal(child.status,0,child.stderr);const expected=JSON.parse(child.stdout);let index=0;
 for(const split of [false,true])for(const interval of [0,1]){
  const frames:any[]=[];const publisher=new MqttStatusPublisher({async publish(topic,payload,options){frames.push({topic,payload:JSON.parse(payload),retain:options.retain});}},'printer',{objects:{toolhead:null,webhooks:null},split,interval},()=>true);
  for(let i=0;i<updates.length;i++){publisher.send(prepareStatus(updates[i]),i+.125);await turn();}publisher.flush();await turn();assert.deepEqual(frames,expected[index++]);await publisher.close();
 }
});
