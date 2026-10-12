import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MoonrakerHttpClient,type HttpRequestOptions} from '../src/moonraker/http-client.ts';
import {Announcements} from '../src/moonraker/announcements.ts';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
test('standard announcement updates use one borrowed HTTP owner, physical loopback, persistent ETags and bounded XML',async()=>{
 const requests:{name:string;etag?:string;agent?:string}[]=[],server=createServer((req,res)=>{
  const name=new URL(req.url!,'http://synthetic').searchParams.get('feed')!;requests.push({name,etag:req.headers['if-none-match'],agent:req.headers['user-agent']});
  if(req.headers['if-none-match']==='"v1"'){res.writeHead(304);res.end();return;}
  res.writeHead(200,{etag:'"v1"'});res.end('<rss><channel><title>Fixture</title><item><guid>'+name+'/notice</guid><title>Notice</title></item></channel></rss>');
 });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert(address&&typeof address==='object');const base='http://127.0.0.1:'+address.port;
 class LocalClient extends MoonrakerHttpClient {override get(url:string,options:HttpRequestOptions={}){assert(url.startsWith('https://arksine.github.io/moonlight/assets/'));assert.equal(options.redirect,'error');assert.equal(options.enableCache,false);assert.equal(options.maxBodyBytes,1048576);const name=new URL(url).pathname.split('/').at(-1)!.replace(/\.xml$/,'');return super.get(base+'/?feed='+name,options);}}
 const client=new LocalClient(),root=await mkdtemp(join(tmpdir(),'http-announcements-')),db=await DatabaseStore.open({path:join(root,'db.sqlite')}),config=new ConfigurationReader(new ConfigurationSource('/synthetic/config',{server:{},announcements:{enable_moonlight:'true'}},[])),events:string[]=[],owner=new Announcements(config,db,method=>events.push(method),{},client);
 try{await owner.start();assert.equal((await owner.update({},new AbortController().signal)).modified,true);assert.deepEqual(owner.list().entries.map(entry=>entry.entry_id).sort(),['klipper/notice','moonraker/notice']);assert.equal((await owner.update({},new AbortController().signal)).modified,false);assert.equal(events.filter(method=>method==='notify_announcement_update').length,1);assert(requests.slice(2).every(row=>row.etag==='"v1"'));assert(requests.every(row=>row.agent==='Moonraker'));assert.equal(client.status.cacheEntries,0);await owner.close();assert.equal(client.status.closed,false,'borrower may not close the process owner');assert.equal(client.status.pending,0);}finally{await owner.close();await client.close();await db.close();await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});await rm(root,{recursive:true,force:true});}
});
