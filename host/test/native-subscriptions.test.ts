import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeObjects} from '../src/moonraker/native-objects.ts';
import {NativeSubscriptions} from '../src/moonraker/native-subscriptions.ts';
import type {Json} from '../src/moonraker/rpc.ts';
test('native subscriptions sample once per object, send only changes and preserve Python equality',async()=>{
 let now=1,calls=0,data:Record<string,Json>={position:[1.005,-0,2.675],flag:true,nested:{a:1,b:2}},messages:any[]=[];
 const objects=new NativeObjects(new Map([['toolhead',()=>{calls++;return data;}]]),()=>now),owner=new NativeSubscriptions(objects,{deliver:(id,status,eventtime)=>messages.push({id,status,eventtime}),disconnect:()=>assert.fail('unexpected disconnect')});
 try{
  const first=await owner.subscribe(1,{toolhead:null,missing:['absent']});await owner.subscribe(2,{toolhead:['position']});calls=0;now=2;owner.sample();assert.equal(calls,1);assert.deepEqual(messages,[]);
  data={...data,flag:1,nested:{b:2,a:1},position:[1.005,0,2.675]};now=3;owner.sample();assert.deepEqual(messages,[]);
  data={...data,position:[1.005,0,3.675],new_field:9};now=4;owner.sample();assert.deepEqual(messages,[1,2].map(id=>({id,status:{toolhead:{position:data.position}},eventtime:4})));assert.deepEqual(first.status.toolhead.position,[1.005,-0,2.675]);assert(Object.isFrozen(first.status.toolhead.position));
  messages=[];await owner.subscribe(1,{toolhead:['flag']});data={...data,flag:2,position:[0,0,0]};now=5;owner.sample();assert.deepEqual(messages.map(m=>m.status),[{toolhead:{flag:2}},{toolhead:{position:[0,0,0]}}]);
  await owner.subscribe(1,{});owner.remove(2);assert.equal(owner.metrics.sampling,false);calls=0;owner.sample();assert.equal(calls,0);
 }finally{owner.close();}await assert.rejects(owner.subscribe(1,{}),/closed/);
});
test('native subscription capacity and failed replacement leave prior selection intact',async()=>{
 let calls=0;const messages:any[]=[],objects=new NativeObjects(new Map([['data',()=>{calls++;return {value:calls};}]]),()=>1),owner=new NativeSubscriptions(objects,{deliver:(id,status)=>messages.push({id,status}),disconnect:()=>assert.fail()});
 try{
  await owner.subscribe(1,{data:['value']});await assert.rejects(owner.subscribe(1,{data:'invalid'}));await assert.rejects(owner.subscribe(2,{},AbortSignal.abort()));
  const many=Object.fromEntries(Array.from({length:4},(_,i)=>['x'+i,Array.from({length:4096},(_,j)=>'f'+j)]));await assert.rejects(owner.subscribe(2,many),/capacity/);assert.equal(calls,1);owner.sample();assert.equal(messages[0].id,1);
  for(let id=2;id<=256;id++)await owner.subscribe(id,{missing:[]});await assert.rejects(owner.subscribe(257,{data:null}),/capacity/);owner.remove(2);await owner.subscribe(257,{data:null});assert.equal(owner.metrics.clients,256);
 }finally{owner.close();}
});
test('sampling fault disconnects subscribers, clears timer and permits a fresh request after recovery',async()=>{
 let fault=false,value=1;const ids:number[]=[],objects=new NativeObjects(new Map([['data',()=>{if(fault)throw Error('private');return {value};}]]),()=>1),owner=new NativeSubscriptions(objects,{deliver(){throw Error('delivery failure');},disconnect:id=>ids.push(id)});
 try{await owner.subscribe(1,{data:null});await owner.subscribe(2,{data:null});fault=true;owner.sample();assert.deepEqual(ids,[1,2]);assert.equal(owner.metrics.clients,0);assert.equal(owner.metrics.sampling,false);fault=false;await owner.subscribe(3,{data:null});value=2;owner.sample();assert.deepEqual(ids,[1,2,3]);assert.equal(owner.metrics.clients,0);}finally{owner.close();}
});
test('real periodic native sampling starts and stops with subscriptions',async()=>{
 let value=0;const changed=Promise.withResolvers<void>(),owner=new NativeSubscriptions(new NativeObjects(new Map([['data',()=>({value})]]),()=>performance.now()/1000),{deliver(){changed.resolve();},disconnect:()=>assert.fail()});
 const deadline=setTimeout(()=>changed.reject(Error('sampling timeout')),2000);
 try{await owner.subscribe(1,{data:null});value=1;await changed.promise;owner.remove(1);assert.equal(owner.metrics.sampling,false);assert(owner.metrics.samples>=1);}finally{clearTimeout(deadline);owner.close();}
});
test('empty all-field selection resolves when data appears and special keys remain ordinary fields',async()=>{
 let data:Record<string,Json>={};const updates:any[]=[],owner=new NativeSubscriptions(new NativeObjects(new Map([['__proto__',()=>data]]),()=>1),{deliver:(_id,status)=>updates.push(status),disconnect:()=>assert.fail()});
 try{await owner.subscribe(1,Object.fromEntries([['__proto__',null]]));data=Object.fromEntries([['__proto__',1]]);owner.sample();assert.deepEqual(updates,[Object.fromEntries([['__proto__',data]])]);data={...data,new:2};owner.sample();assert.equal(updates.length,1);data=Object.fromEntries([['__proto__',null]]);owner.sample();assert.deepEqual(updates[1],Object.fromEntries([['__proto__',data]]));}finally{owner.close();}
});
