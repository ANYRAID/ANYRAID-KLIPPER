import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {Webcams} from '../src/moonraker/webcams.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import type {Json} from '../src/moonraker/rpc.ts';
const config=()=>new ConfigurationReader(new ConfigurationSource('/moonraker.conf',{server:{},'webcam fixed':{stream_url:'/webcam/?action=stream'}},[]));
test('webcams preserve config identity, transactional CRUD, notification snapshots and restart persistence',async t=>{
 const root=await mkdtemp(join(tmpdir(),'webcams-')),path=join(root,'db.sqlite');let db=await DatabaseStore.open({path});const events:Json[]=[];let cams=new Webcams(config(),db,event=>events.push(event));
 try{await cams.start();const fixed=cams.get({name:'fixed'}).webcam;assert.equal(fixed.source,'config');assert.equal(fixed.target_fps,15);assert.match(fixed.uid,/^[a-f0-9-]{36}$/);await assert.rejects(cams.mutate({uid:fixed.uid,stream_url:'/other'}),/configuration/);await assert.rejects(cams.mutate({uid:fixed.uid},true),/configuration/);
  const created=await cams.mutate({name:'desk',stream_url:'/stream',extra_data:{a:[1,2]},flip_horizontal:true}) as any;const uid=created.webcam.uid;assert.equal(cams.list().webcams.length,2);created.webcam.extra_data.a.push(3);assert.deepEqual(cams.get({uid}).webcam.extra_data,{a:[1,2]});
  await cams.mutate({uid,name:'renamed',target_fps:'30'});assert.throws(()=>cams.get({name:'desk'}),/not found/);assert.equal(cams.get({uid}).webcam.target_fps,30);
  await assert.rejects(cams.mutate({uid,name:'fixed'}),/already exists/);assert.equal(cams.get({uid}).webcam.name,'renamed');await assert.rejects(cams.mutate({uid,rotation:45}),/rotation/);assert.equal(cams.get({uid}).webcam.rotation,0);
  const race=await Promise.allSettled([cams.mutate({name:'unique',stream_url:'/a'}),cams.mutate({uid,name:'unique'})]);assert.equal(race[0].status,'fulfilled');assert.equal(race[1].status,'rejected');assert.equal(events.length,3);
  const stored:any=await db.get('webcams',[uid]);assert.equal(stored.urlStream,'/stream');assert.equal(stored.targetFps,30);
  const start=performance.now();for(let i=0;i<10000;i++)cams.list();t.diagnostic(JSON.stringify({cachedListMeanUs:(performance.now()-start)*1000/10000,cameras:3,scope:'desktop snapshot query'}));
  await cams.close();await db.close();db=await DatabaseStore.open({path});cams=new Webcams(config(),db,event=>events.push(event));await cams.start();assert.equal(cams.get({name:'fixed'}).webcam.uid,fixed.uid);assert.equal(cams.get({uid}).webcam.name,'renamed');await cams.mutate({uid},true);assert.throws(()=>cams.get({uid}),/not found/);assert.equal(events.length,4);
 }finally{await cams.close();await db.close();await rm(root,{recursive:true,force:true});}
});
test('webcam snapshot probe reads bounded response and handles errors and shutdown',async()=>{
 const root=await mkdtemp(join(tmpdir(),'webcam-probe-')),db=await DatabaseStore.open({path:join(root,'db.sqlite')}),cams=new Webcams(config(),db,()=>{}),http=createServer((req,res)=>{if(req.url==='/missing'){res.writeHead(404);res.end();}else if(req.url==='/large'){res.end(Buffer.alloc(8388609));}else if(req.url==='/slow'){setTimeout(()=>res.end('late'),1500).unref();}else res.end('snapshot');});
 try{await cams.start();http.listen(0,'127.0.0.1');await once(http,'listening');const addr=http.address();assert(addr&&typeof addr!=='string');const base=`http://127.0.0.1:${addr.port}`;
  await cams.mutate({name:'test',stream_url:'/stream',snapshot_url:base+'/ok'});let result:any=await cams.test({name:'test'});assert.equal(result.snapshot_reachable,true);assert.equal(result.stream_url,'http://127.0.0.1/stream');
  await cams.mutate({name:'test',snapshot_url:base+'/missing'});result=await cams.test({name:'test'});assert.equal(result.snapshot_reachable,false);
  await cams.mutate({name:'test',snapshot_url:base+'/large'});assert.equal((await cams.test({name:'test'}) as any).snapshot_reachable,false);
  await cams.mutate({name:'test',snapshot_url:base+'/slow'});assert.equal((await cams.test({name:'test'}) as any).snapshot_reachable,false);const probe=cams.test({name:'test'});await cams.close();assert.equal((await probe as any).snapshot_reachable,false);assert.throws(()=>cams.list(),/unavailable/);
 }finally{await cams.close();http.closeAllConnections();await new Promise<void>(resolve=>http.close(()=>resolve()));await db.close();await rm(root,{recursive:true,force:true});}
});
test('failed webcam persistence publishes no change and requires restart',async()=>{
 const root=await mkdtemp(join(tmpdir(),'webcam-fault-')),db=await DatabaseStore.open({path:join(root,'db.sqlite')}),events:Json[]=[],cams=new Webcams(config(),db,event=>events.push(event)),insert=db.insert;
 try{await cams.start();db.insert=async()=>{throw Error('injected persistence failure');};await assert.rejects(cams.mutate({name:'lost',stream_url:'/stream'}),/persistence failure/);assert.deepEqual(events,[]);assert.throws(()=>cams.list(),/unavailable/);assert.deepEqual(await db.get('webcams'),{});
 }finally{db.insert=insert;await cams.close();await db.close();await rm(root,{recursive:true,force:true});}
});
test('webcam close refuses new operations and waits accepted durable write',async()=>{
 const root=await mkdtemp(join(tmpdir(),'webcam-drain-')),db=await DatabaseStore.open({path:join(root,'db.sqlite')}),cams=new Webcams(config(),db,()=>{}),insert=db.insert;
 try{await cams.start();const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();db.insert=async(...args)=>{entered.resolve();await release.promise;return insert.apply(db,args);};const write=cams.mutate({name:'pending',stream_url:'/stream'});await entered.promise;const close=cams.close();assert.throws(()=>cams.mutate({name:'late',stream_url:'/late'}),/unavailable/);release.resolve();const result:any=await write;await close;assert.equal((await db.get('webcams',[result.webcam.uid]) as any).name,'pending');
 }finally{db.insert=insert;await cams.close();await db.close();await rm(root,{recursive:true,force:true});}
});
