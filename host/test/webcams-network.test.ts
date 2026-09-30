import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
const information={connected:false,state:'disconnected' as const,components:[],failedComponents:[],directories:[],warnings:[],version:'webcam-test',missingRequirements:[]};
test('configured webcams authorize HTTP/RPC and changed notifications; retain persistence after restart',async()=>{
 const root=await mkdtemp(join(tmpdir(),'webcams-network-')),path=join(root,'db.sqlite'),config=join(root,'moonraker.conf');let db=await DatabaseStore.open({path}),server:ConfiguredMoonraker|undefined;const sockets:WebSocket[]=[];
 try{await writeFile(config,'[server]\nhost:127.0.0.1\nport:0\n[webcam static]\nstream_url:/static\n');server=await ConfiguredMoonraker.loadAuthorized(config,{information,database:db,authorization:{issuer:'http://printer.test'}});const key=server.authorization!.localApiKey(),address=await server.start(),base=`http://127.0.0.1:${address.port}`,headers={'x-api-key':key,'content-type':'application/json'};
  assert.equal((await fetch(base+'/server/webcams/list')).status,401);const denied=new WebSocket(base.replace('http:','ws:')+'/websocket'),allowed=new WebSocket(base.replace('http:','ws:')+'/websocket',{headers});sockets.push(denied,allowed);await Promise.all(sockets.map(ws=>once(ws,'open')));const deniedEvents:unknown[]=[];denied.on('message',message=>deniedEvents.push(JSON.parse(String(message))));
  const event=once(allowed,'message',{signal:AbortSignal.timeout(3000)}),added=await fetch(base+'/server/webcams/item',{method:'POST',headers,body:JSON.stringify({name:'live',stream_url:'/live'})});assert.equal(added.status,200);const uid=(await added.json()).result.webcam.uid;
  assert.equal(JSON.parse(String((await event)[0])).method,'notify_webcams_changed');assert.equal(deniedEvents.length,0);
  const response=once(allowed,'message');allowed.send(JSON.stringify({jsonrpc:'2.0',id:9,method:'server.webcams.get_item',params:{uid}}));assert.equal(JSON.parse(String((await response)[0])).result.webcam.name,'live');
  assert.equal((await fetch(base+'/server/database/item',{method:'POST',headers,body:JSON.stringify({namespace:'webcams',key:uid,value:{name:'bypass'}})})).status,403);
  for(const ws of sockets)ws.terminate();await server.close();db=await DatabaseStore.open({path});server=await ConfiguredMoonraker.loadAuthorized(config,{information,database:db,authorization:{issuer:'http://printer.test'}});const restarted=await server.start();const listed=await fetch(`http://127.0.0.1:${restarted.port}/server/webcams/list`,{headers});assert.equal((await listed.json()).result.webcams.find((cam:any)=>cam.uid===uid).name,'live');
 }finally{for(const ws of sockets)ws.terminate();await server?.close();await db.close();await rm(root,{recursive:true,force:true});}
});
