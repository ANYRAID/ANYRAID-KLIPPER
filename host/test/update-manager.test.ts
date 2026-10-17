import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WebSocket} from 'ws';
import {UpdateManager} from '../src/moonraker/update-manager.ts';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {MoonrakerHttpClient} from '../src/moonraker/http-client.ts';
import {ApiError,type Json} from '../src/moonraker/rpc.ts';
const signal=()=>AbortSignal.timeout(8000);
const wait=async(check:()=>boolean)=>{const until=Date.now()+4000;while(!check()&&Date.now()<until)await new Promise(r=>setTimeout(r,5));assert(check(),'bounded observation expired');};
const code=(status:number)=>(e:unknown)=>e instanceof ApiError&&e.status===status;
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'update-manager-')),app=join(root,'web');await import('node:fs/promises').then(fs=>fs.mkdir(app));await writeFile(join(app,'release_info.json'),JSON.stringify({project_owner:'fixture',project_name:'web',version:'v1'}));
 let calls=0,active=0,maxActive=0,hold=false;const releases:Array<()=>void>=[],paths:string[]=[];
 const peer=createServer(async(req,res)=>{calls++;paths.push(req.url!);active++;maxActive=Math.max(maxActive,active);try{if(hold)await new Promise<void>(resolve=>{releases.push(resolve);res.once('close',resolve);});if(!res.destroyed){res.setHeader('content-type','application/json');res.end(JSON.stringify({tag_name:'v2',assets:[]}));}}finally{active--;}});
 await new Promise<void>(r=>peer.listen(0,'127.0.0.1',r));const address=peer.address();assert(address&&typeof address==='object');
 const client=new MoonrakerHttpClient(),redirect=(http:MoonrakerHttpClient)=>{const get=http.get.bind(http);http.get=(url,options)=>{assert.equal(new URL(url).origin,'https://api.github.com');return get('http://127.0.0.1:'+address.port+new URL(url).pathname+new URL(url).search,{...options,enableCache:false});};};redirect(client);
 const db=await DatabaseStore.open({path:join(root,'db.sqlite')}),events:Array<{method:string,value:Json,at:number}>=[];let blocked=false;
 const reader=(extra:Record<string,string>={})=>new ConfigurationReader(new ConfigurationSource(join(root,'main.conf'),{DEFAULT:{},server:{},update_manager:{enable_system_updates:'false',...extra},'update_manager client':{type:'web',path:app,repo:'fixture/web'}},[]));
 const owner=()=>new UpdateManager(reader(),db,client,()=>blocked,(method,value)=>events.push({method,value,at:Date.now()}));
 return {root,app,db,client,events,reader,owner,redirect,paths,get calls(){return calls;},get maxActive(){return maxActive;},setBlocked(v:boolean){blocked=v;},hold(){hold=true;},release(){hold=false;for(const r of releases.splice(0))r();},async close(){for(const r of releases.splice(0))r();await client.close();await db.close();peer.closeAllConnections();await new Promise<void>(r=>peer.close(()=>r()));await rm(root,{recursive:true,force:true});}};
}
test('update configuration rejects invalid values and web dev is explicitly downgraded',async()=>{
 const f=await fixture();try{for(const values of [{refresh_window:'5-5'},{refresh_interval:'-1'},{channel:'nightly'},{client_repo:'old/repo'}] as Record<string,string>[])assert.throws(()=>new UpdateManager(f.reader(values),f.db,f.client,()=>false,()=>{}));
  const source=f.reader().source.original as Record<string,Record<string,string>>;const reader=new ConfigurationReader(new ConfigurationSource(join(f.root,'dev.conf'),{...source,'update_manager client':{...source['update_manager client'],channel:'dev'}},[]));const owner=new UpdateManager(reader,f.db,f.client,()=>false,()=>{});try{await owner.start();const status=(owner.snapshot().version_info as any).client;assert.equal(status.channel,'stable');assert.equal(status.channel_invalid,true);assert.deepEqual((owner.snapshot().version_info as any).moonraker,{});}finally{await owner.close();}
 }finally{await f.close();}
});
test('startup gates refresh, cached reads do no IO, busy gates and core no-op follow the registered contract',async()=>{
 const f=await fixture(),owner=f.owner();try{await owner.start();assert.equal(f.calls,0);await assert.rejects(owner.refresh({},signal()),code(503));await owner.get({refresh:true},signal());assert.equal(f.calls,0);
  f.setBlocked(true);owner.beginUpdates();await wait(()=>owner.status.initialRefreshComplete);await assert.rejects(owner.refresh({},signal()),code(503));await owner.get({refresh:true},signal());assert.equal(f.calls,0);f.setBlocked(false);
  await owner.refresh({name:'moonraker'},signal());await owner.refresh({name:'klipper'},signal());assert.equal(f.calls,0);await assert.rejects(owner.refresh({name:'missing'},signal()),code(400));
  await owner.refresh({},signal());assert.equal(f.calls,1);for(let i=0;i<20;i++)await owner.get({refresh:false},signal());await owner.get({refresh:true},signal());assert.equal(f.calls,1,'GET refresh obeys sixty-second freshness');assert.equal((owner.snapshot().version_info as any).client.remote_version,'v2');
  await wait(()=>f.events.length===3);assert(f.events.every(e=>e.method==='notify_update_refreshed'));assert(!JSON.stringify(owner.snapshot()).includes('dl_info'));
  const saved=await f.db.get('native_update_manager','state');assert.equal((saved as any).schema,1);await assert.rejects(f.db.api('GET','native_update_manager','state'),code(403));
  await owner.close();const reopened=f.owner();try{await reopened.start();assert.equal((reopened.snapshot().version_info as any).client.remote_version,'v2');assert.equal(f.calls,1);}finally{await reopened.close();}
 }finally{await owner.close();await f.close();}
});
test('refresh serializes real HTTP work, cancelled queued work never replays, and close aborts without a late commit or event',async()=>{
 const f=await fixture(),owner=f.owner();try{f.setBlocked(true);await owner.start();owner.beginUpdates();await wait(()=>owner.status.initialRefreshComplete);f.setBlocked(false);f.hold();
  const first=owner.refresh({},signal());await wait(()=>f.calls===1);const controller=new AbortController(),queued=owner.refresh({},controller.signal),rejected=assert.rejects(queued);controller.abort();const second=owner.refresh({},signal());assert.equal(f.calls,1);assert.equal((owner.snapshot().version_info as any).client.version,'v1');f.release();await first;await rejected;await second;assert.equal(f.calls,2);assert.equal(f.maxActive,1);
  await wait(()=>f.events.length===2);f.events.length=0;const before=await f.db.get('native_update_manager','state');f.hold();const pending=owner.refresh({},signal()),failure=assert.rejects(pending);await wait(()=>f.calls===3);await owner.close();await failure;f.release();await new Promise(r=>setTimeout(r,250));assert.equal(f.events.length,0);assert.deepEqual(await f.db.get('native_update_manager','state'),before);assert.equal(f.db.status.closed,false);assert.equal(owner.status.pending,0);
 }finally{await owner.close();await f.close();}
});
test('ConfiguredMoonraker wires authorized real REST, RPC and WebSocket update status and delayed refresh events',async()=>{
 const f=await fixture();let ws:WebSocket|undefined;const path=join(f.root,'main.conf');await writeFile(path,`[server]\nhost=127.0.0.1\nport=0\n[update_manager]\nenable_system_updates=false\n[update_manager client]\ntype=web\npath=${f.app}\nrepo=fixture/web\n`);
 const authorize=(_m:unknown,_p:unknown,c:any)=>{if(c.request.headers['x-api-key']!=='test')throw new ApiError(401,'Unauthorized');};
 const service=await ConfiguredMoonraker.load(path,{database:f.db,authorize,authorizeNotification:authorize,information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'test',missingRequirements:[]}});f.redirect(service.httpClient);
 try{const address=await service.start(),url='http://127.0.0.1:'+address.port,headers={'x-api-key':'test'};await wait(()=>service.updateManagerStatus!.initialRefreshComplete);assert.equal(f.calls,1);
  assert.equal((await fetch(url+'/machine/update/status')).status,401);for(const query of ['', '?refresh=true','?refresh=FALSE','?refresh:bool=true']){const response=await fetch(url+'/machine/update/status'+query,{headers});assert.equal(response.status,200);assert.equal((await response.json() as any).result.version_info.client.remote_version,'v2');}assert.equal(f.calls,1);
  for(const query of ['?refresh=perhaps','?refresh=1'])assert.equal((await fetch(url+'/machine/update/status'+query,{headers})).status,400);
  const rpc=await fetch(url+'/server/jsonrpc',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'machine.update.status',params:{refresh:false}})});assert.equal((await rpc.json() as any).result.version_info.client.version,'v1');
  assert.equal((await fetch(url+'/machine/update/client',{method:'POST',headers})).status,501);assert.equal(f.calls,1);
  // Drain the startup delayed event before observing this explicit refresh.
  await new Promise(r=>setTimeout(r,250));ws=new WebSocket(url.replace('http:','ws:')+'/websocket',{headers});await once(ws,'open');const messages:any[]=[];let eventAt=0;ws.on('message',data=>{eventAt=Date.now();messages.push(JSON.parse(data.toString()));});const at=Date.now();
  const response=await fetch(url+'/machine/update/refresh',{method:'POST',headers});assert.equal(response.status,200);assert.equal(f.calls,2);await wait(()=>messages.length>0);assert.equal(messages[0].method,'notify_update_refreshed');assert.equal(messages[0].params[0].version_info.client.remote_version,'v2');assert(eventAt-at>=190);assert(messages.every(m=>m.method!=='notify_update_response'));
 }finally{ws?.terminate();await service.close();await f.close();}assert.equal(service.rpc.has('machine.update.status'),false);assert.equal(service.updateManagerStatus!.closing,true);
});

 test('web deployments overlapping configuration, database or backup paths stay invalid and perform no remote IO',async()=>{
  const f=await fixture();try{const source=f.reader().source.original as Record<string,Record<string,string>>;for(const protectedPath of [join(f.root,'main.conf'),f.db.storagePaths.path]){const reader=new ConfigurationReader(new ConfigurationSource(protectedPath,{...source,'update_manager client':{...source['update_manager client'],path:f.root}},[]));await writeFile(join(f.root,'release_info.json'),JSON.stringify({project_owner:'fixture',project_name:'web',version:'v1'}));const owner=new UpdateManager(reader,f.db,f.client,()=>false,()=>{});try{await owner.start();assert.equal((owner.snapshot().version_info as any).client.is_valid,false);owner.beginUpdates();await wait(()=>owner.status.initialRefreshComplete);assert.equal(f.calls,0);}finally{await owner.close();}}
   const app=new (await import('../src/moonraker/update-web-deploy.ts')).WebDeployment({name:'client',path:f.app,repo:'fixture/web',channel:'stable',channelInvalid:false,reportAnomalies:true,infoTags:[],refreshInterval:1,configHash:'x'},f.client,[f.root]);await app.refresh(signal());assert.equal(app.status.is_valid,false);assert.equal(f.calls,0);
  }finally{await f.close();}
 });
