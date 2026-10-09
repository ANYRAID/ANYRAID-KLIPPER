import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WebSocket} from 'ws';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {NativeRequestScope} from '../src/moonraker/native-request-scope.ts';
import type {InformationSnapshot} from '../src/moonraker/metadata.ts';
const info=():InformationSnapshot=>({connected:false,state:'disconnected',components:['application'],failedComponents:[],directories:[],warnings:[],version:'announcement-test',missingRequirements:[]});
test('standard configured Moonraker owns announcement REST/RPC, persistent notifications and credential revocation while printer is disconnected',async()=>{
 const root=await mkdtemp(join(tmpdir(),'announcement-network-')),path=join(root,'moonraker.conf'),db=await DatabaseStore.open({path:join(root,'db.sqlite')});
 let service:ConfiguredMoonraker|undefined,socket:WebSocket|undefined,anonymous:WebSocket|undefined;
 try{
  await writeFile(path,'[server]\nhost=127.0.0.1\nport=0\n[announcements]\nenable_moonlight=false\nsubscriptions=mainsail');
  await db.insert('announcements','000000',{entry_id:'moonraker/test',title:'Fixture notice',description:null,url:null,priority:'normal',date:1700000000,dismissed:false,date_dismissed:null,dismiss_wake:null,source:'moonlight',feed:'moonraker'});
  service=await ConfiguredMoonraker.loadAuthorized(path,{database:db,authorization:{issuer:'http://announcement.test'},information:info()});
  const key=service.authorization!.localApiKey(),headers={'x-api-key':key},address=await service.start(),base='http://127.0.0.1:'+address.port;
  assert.equal((await fetch(base+'/server/announcements/list')).status,401);
  for(const state of ['disconnected','shutdown','ready'] as const){
   service.setInformation({...info(),state,connected:state!=='disconnected'});
   const discovered:any=await(await fetch(base+'/server/info',{headers})).json();
   assert.equal(discovered.result.components.filter((name:string)=>name==='announcements').length,1);
   assert.equal(discovered.result.klippy_state,state);
  }
  const listed:any=await(await fetch(base+'/server/announcements/list',{headers})).json();
  assert.deepEqual(listed.result.feeds,['moonraker','klipper','mainsail']);assert.equal(listed.result.entries.length,1);
  socket=new WebSocket(base.replace('http:','ws:')+'/websocket',{headers});await once(socket,'open');
  const events:any[]=[];socket.on('message',bytes=>{const value=JSON.parse(bytes.toString());if(value.method)events.push(value);});
  let id=0;
  const request=(method:string,params:unknown={},target=socket!)=>new Promise<any>((resolve,reject)=>{
   const current=++id,timeout=setTimeout(()=>{target.off('message',onMessage);reject(Error('Announcement RPC observation timeout'));},4000);
   const onMessage=(bytes:Buffer)=>{const value=JSON.parse(bytes.toString());if(value.id!==current)return;clearTimeout(timeout);target.off('message',onMessage);resolve(value);};
   target.on('message',onMessage);target.send(JSON.stringify({jsonrpc:'2.0',id:current,method,params}));
  });
  assert.deepEqual((await request('server.announcements.list')).result,listed.result);
  assert.deepEqual((await request('server.announcements.dismiss',{entry_id:'moonraker/test'})).result,{entry_id:'moonraker/test'});
  const deadline=performance.now()+3000;while(!events.some(e=>e.method==='notify_announcement_dismissed')){assert(performance.now()<deadline);await new Promise(r=>setTimeout(r,10));}
  assert.deepEqual(events.find(e=>e.method==='notify_announcement_dismissed').params,[{entry_id:'moonraker/test'}]);
  const dismissed:any=await(await fetch(base+'/server/announcements/list?include_dismissed:bool=false',{headers})).json();assert.deepEqual(dismissed.result.entries,[]);
  const feedHeaders={...headers,'content-type':'application/json'};
  assert.deepEqual((await(await fetch(base+'/server/announcements/feed',{method:'POST',headers:feedHeaders,body:JSON.stringify({name:'fluidd'})})).json() as any).result,{feed:'fluidd',action:'added'});
  assert.deepEqual((await request('server.announcements.feeds')).result.feeds,['moonraker','klipper','mainsail','fluidd']);
  assert.equal((await(await fetch(base+'/server/announcements/update',{method:'POST',headers:feedHeaders,body:JSON.stringify({subscriptions:['fluidd']})})).json() as any).result.modified,false);
  assert.equal((await(await fetch(base+'/server/announcements/feed',{method:'DELETE',headers:feedHeaders,body:JSON.stringify({name:'fluidd'})})).json() as any).result.action,'removed');
  anonymous=new WebSocket(base.replace('http:','ws:')+'/websocket');await once(anonymous,'open');const denied=await request('server.announcements.list',{},anonymous);assert.equal(denied.error.code,-32602);assert.equal(denied.error.message,'Unauthorized');
  await service.authorization!.rotate();const revoked=await request('server.announcements.list');assert.equal(revoked.error.code,-32602);assert.equal(revoked.error.message,'Invalid API Key');
  assert.equal((await fetch(base+'/server/announcements/list',{headers})).status,401);
  socket.terminate();anonymous.terminate();await service.close();
  assert.equal(service.rpc.has('server.announcements.list'),false);assert.equal(db.status.closed,true);
 }finally{socket?.terminate();anonymous?.terminate();await service?.close();await db.close();await rm(root,{recursive:true,force:true});}
});
test('announcements cannot acquire a retired native printer generation and unowned explicit config fails before listening',async()=>{
 const scope=new NativeRequestScope();scope.retire();
 const handler=scope.wrap('/server/announcements/list',()=>({entries:[],feeds:[]}));
 assert.deepEqual(await handler({},'GET',{transport:'http',signal:new AbortController().signal,authorize:()=>undefined}),{entries:[],feeds:[]});
 const root=await mkdtemp(join(tmpdir(),'announcement-missing-owner-')),path=join(root,'moonraker.conf');
 try{await writeFile(path,'[server]\nport=0\n[announcements]\nenable_moonlight=false');await assert.rejects(ConfiguredMoonraker.load(path,{information:info(),authorize:()=>undefined}),/database/);}
 finally{await rm(root,{recursive:true,force:true});}
});
