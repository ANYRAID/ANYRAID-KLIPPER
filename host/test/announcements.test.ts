import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {Announcements,type AnnouncementsOptions,type AnnouncementEntry} from '../src/moonraker/announcements.ts';
import {parseAnnouncementFeed} from '../src/moonraker/announcements-rss.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {ApiError,type Json} from '../src/moonraker/rpc.ts';
const reader=(options:Record<string,string>={})=>new ConfigurationReader(new ConfigurationSource('/moonraker.conf',{server:{},announcements:{enable_moonlight:'false',...options}},[]));
const life=()=>new AbortController().signal;
const rss=(items:string,title='Moonraker')=>'<rss version="2.0"><channel><title>'+title+'</title>'+items+'</channel></rss>';
const item=(id:string,title='Notice')=>'<item><guid>'+id+'</guid><title>'+title+'</title><link>https://example.invalid/notice</link><description><![CDATA[<p>Motion-independent &amp; notice</p>]]></description><category>normal</category><pubDate>Wed, 07 Oct 2026 01:02:03 GMT</pubDate></item>';
const fixed=(id='moonraker/old',feed='moonraker'):AnnouncementEntry=>({entry_id:id,url:null,title:'Old',description:null,priority:'normal',date:1790000000,dismissed:false,date_dismissed:null,dismiss_wake:null,source:'moonlight',feed});
async function fixture(run:(db:DatabaseStore,root:string)=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'announcements-')),db=await DatabaseStore.open({path:join(root,'db.sqlite')});
 try{await run(db,root);}finally{await db.close();await rm(root,{recursive:true,force:true});}
}
async function until(predicate:()=>boolean){
 const stop=performance.now()+3000;
 while(!predicate()){if(performance.now()>stop)throw Error('Announcement observation deadline exceeded');await new Promise(resolve=>setTimeout(resolve,10));}
}
test('announcement RSS follows pinned nullable fields, RFC date, CDATA, namespace and missing-guid semantics',()=>{
 const parsed=parseAnnouncementFeed(rss(item('moonraker/news')+'<item><title>Missing GUID</title></item><item><guid>moonraker/empty</guid></item>'),123)!;
 assert.equal(parsed.prefix,'moonraker');assert.equal(parsed.items.length,2);
 assert.deepEqual(parsed.items[0],{entry_id:'moonraker/news',url:'https://example.invalid/notice',title:'Notice',description:'<p>Motion-independent &amp; notice</p>',priority:'normal',date:Date.UTC(2026,9,7,1,2,3)/1000});
 assert.deepEqual(parsed.items[1],{entry_id:'moonraker/empty',url:null,title:null,description:null,priority:null,date:123});
 assert.equal(parseAnnouncementFeed('<rss><other/></rss>',123),null);
 assert.equal(parseAnnouncementFeed('<rss xmlns="urn:non-rss"><channel><title>Namespaced</title></channel></rss>',123),null);
 assert.equal(parseAnnouncementFeed(rss('<item><guid>moonraker/empty-fields</guid><link/><title/><description/><category/></item>'),123)!.items[0].description,'');
 assert.throws(()=>parseAnnouncementFeed('<rss><unknown:channel/></rss>',123),/XML/);
 assert.equal(parseAnnouncementFeed(rss(item('feed/sub/id'),''),123)!.prefix,'feed/sub');
 assert.throws(()=>parseAnnouncementFeed('<!DOCTYPE rss [<!ENTITY x "data">]><rss><channel><title>&x;</title></channel></rss>',123),/DTD/);
 assert.throws(()=>parseAnnouncementFeed('<rss><channel></rss>',123),/XML/);
 assert.throws(()=>parseAnnouncementFeed(rss(item('id').repeat(257)),123),/capacity/);
 assert.throws(()=>parseAnnouncementFeed('<rss>'+ '<x>'.repeat(33)+'data'+'</x>'.repeat(33)+'</rss>',123),/capacity/);
});
test('announcement import, ordering, dismissed filtering, immutable snapshots and upstream wake recovery survive restart',()=>fixture(async(db,root)=>{
 const one=fixed('moonraker/first'),two={...fixed('moonraker/second'),date:one.date+1,dismissed:true,date_dismissed:one.date,dismiss_wake:Date.now()/1000+5};
 await db.insert('announcements','000000',one);await db.insert('announcements','000001',two);
 await db.insert('moonraker','announcements',{stored_feeds:['fluidd'],fluidd:{etag:'"legacy"'}});
 const events:{method:string,value:Json}[]=[],owner=new Announcements(reader(),db,(method,value)=>events.push({method,value}));
 try{
  await owner.start();assert.deepEqual(owner.feeds(),{feeds:['moonraker','klipper','fluidd']});
  const listed=owner.list();assert.deepEqual(listed.entries.map(e=>e.entry_id),['moonraker/second','moonraker/first']);assert.equal(listed.entries[0].dismissed,false,'near wake restores before listening');
  listed.entries[0].title='mutated';assert.equal(owner.list().entries[0].title,'Old');
  await owner.dismiss({entry_id:one.entry_id},life());assert.equal(owner.list({include_dismissed:false}).entries.length,1);
  assert.deepEqual(events,[{method:'notify_announcement_dismissed',value:{entry_id:one.entry_id}}]);
  await owner.dismiss({entry_id:one.entry_id,wake_time:0},life());assert.equal(owner.list().entries[1].dismiss_wake,null,'already dismissed is a no-op');
  await assert.rejects(owner.dismiss({entry_id:'missing'},life()),e=>e instanceof ApiError&&e.status===404);
  assert.throws(()=>owner.list({include_dismissed:0}),/include_dismissed/);
  assert.throws(()=>owner.dismiss({entry_id:one.entry_id,wake_time:1.5},life()),/dismissal/);
  assert(!((await db.list()) as {namespaces:string[]}).namespaces.includes('native_announcements'));
  await assert.rejects(db.api('POST','announcements','000000',{}),e=>e instanceof ApiError&&e.status===403);
  assert.deepEqual(await db.get('announcements','000000'),one,'legacy rollback source is retained');
  await owner.close();
  const reopened=new Announcements(reader(),db,()=>{});try{await reopened.start();assert.equal(reopened.list().entries.length,2);assert.equal(reopened.list().entries[1].dismissed,true);assert.equal((await db.get('native_announcements','catalogue') as any).etags.fluidd,'"legacy"');}finally{await reopened.close();}
 }finally{await owner.close();}
}));
test('announcement updates preserve dismissal, atomically prune own feed, persist ETags and publish exact notifications',()=>fixture(async db=>{
 let xml=rss(item('moonraker/first')+item('moonraker/second')),etag='"v1"';
 const requests:{url:string,headers:Headers}[]=[],events:{method:string,value:Json}[]=[];
 const remote:typeof fetch=async(url,init)=>{requests.push({url:String(url),headers:new Headers(init?.headers)});return new Response(xml,{headers:{etag,'content-type':'application/xml'}});};
 const owner=new Announcements(reader({enable_moonlight:'true'}),db,(method,value)=>events.push({method,value}),{fetch:remote});
 try{
  await owner.start();let result=await owner.update({subscriptions:['moonraker']},life());assert.equal(result.modified,true);assert.equal(result.entries.length,2);
  assert.equal(requests[0].url,'https://arksine.github.io/moonlight/assets/moonraker.xml');assert.equal(requests[0].headers.get('Accept'),'application/xml');
  await owner.dismiss({entry_id:'moonraker/first'},life());
  xml=rss(item('moonraker/first','Changed title')+item('moonraker/third'));etag='"v2"';
  result=await owner.update({subscriptions:'moonraker'},life());assert.equal(result.modified,true);assert.deepEqual(result.entries.map(e=>e.entry_id),['moonraker/first','moonraker/third']);
  assert.equal(result.entries[0].dismissed,true);assert.equal(result.entries[0].title,'Notice','existing GUID is not rewritten upstream');
  assert.equal(requests[1].headers.get('If-None-Match'),'"v1"');
  assert.equal((await db.get('native_announcements','catalogue') as any).etags.moonraker,'"v2"');
  const before=events.length;assert.equal((await owner.update({subscriptions:['moonraker']},life())).modified,false);assert.equal(events.length,before);
  await assert.rejects(owner.update({subscriptions:['unknown']},life()),/Unknown/);assert.equal(requests.length,3);
  assert.equal(events.filter(e=>e.method==='notify_announcement_update').length,2);
 }finally{await owner.close();}
}));
test('feed CRUD is durable, protects configuration, bounds names and does not prune another feed with a colliding prefix',()=>fixture(async db=>{
 let xml=rss(item('moonraker/shared'), 'Moonraker');
 const remote:typeof fetch=async()=>new Response(xml,{headers:{etag:'"feed"'}});
 const owner=new Announcements(reader({enable_moonlight:'true',subscriptions:'Mainsail'}),db,()=>{},{fetch:remote});
 try{
  await owner.start();assert.deepEqual(await owner.feed({name:'FLUIDD'},false,life()),{feed:'fluidd',action:'added'});assert.equal(owner.list().entries[0].feed,'fluidd');
  xml=rss('','Moonraker');await owner.update({subscriptions:['moonraker']},life());assert.equal(owner.list().entries.length,1,'a different subscription cannot prune existing source');
  assert.deepEqual(await owner.feed({name:'fluidd'},false,life()),{feed:'fluidd',action:'skipped'});
  await assert.rejects(owner.feed({name:'moonraker'},true,life()),/not stored/);
  for(const name of ['../private','https://localhost/x','x.xml','_hidden','a'.repeat(65)])assert.throws(()=>owner.feed({name},false,life()),/feed name/);
  assert.deepEqual(await owner.feed({name:'fluidd'},true,life()),{feed:'fluidd',action:'removed'});assert.equal(owner.list().entries.length,0);
  await owner.close();const reopened=new Announcements(reader({subscriptions:'mainsail'}),db,()=>{});try{await reopened.start();assert.deepEqual(reopened.feeds(),{feeds:['moonraker','klipper','mainsail']});}finally{await reopened.close();}
 }finally{await owner.close();}
}));
test('304, oversized XML, invalid XML, DTD and remote errors cannot replace cached entries or poison the ETag',()=>fixture(async db=>{
 let mode='valid';
 const remote:typeof fetch=async()=>mode==='304'?new Response(null,{status:304}):mode==='error'?new Response('error',{status:503}):new Response(mode==='valid'?rss(item('moonraker/kept')):mode==='large'?'x'.repeat(1048577):mode==='dtd'?'<!DOCTYPE rss><rss><channel/></rss>':'<rss><broken>',{headers:{etag:'"'+mode+'"'}});
 const owner=new Announcements(reader({enable_moonlight:'true'}),db,()=>{},{fetch:remote});
 try{
  await owner.start();await owner.update({subscriptions:['moonraker']},life());
  for(mode of ['304','error','large','dtd','invalid']){
   const result=await owner.update({subscriptions:['moonraker']},life());assert.equal(result.modified,false);assert.equal(result.entries[0].entry_id,'moonraker/kept');
   assert.equal((await db.get('native_announcements','catalogue') as any).etags.moonraker,'"valid"');
  }
 }finally{await owner.close();}
}));
test('dismiss wake persists reset and notification, and removal cancels its timer',()=>fixture(async db=>{
 const events:{method:string,value:Json}[]=[],owner=new Announcements(reader(),db,(method,value)=>events.push({method,value}));
 try{
  await owner.start();const added=await owner.addInternal('Internal','description','https://example.invalid');
  await owner.dismiss({entry_id:added.entry_id,wake_time:0},life());await until(()=>events.some(e=>e.method==='notify_announcement_wake'));
  assert.equal(owner.list().entries[0].dismissed,false);assert.equal(owner.list().entries[0].dismiss_wake,null);
  assert.deepEqual(events.filter(e=>e.method==='notify_announcement_wake'),[{method:'notify_announcement_wake',value:{entry_id:added.entry_id}}]);
  await owner.dismiss({entry_id:added.entry_id,wake_time:30},life());await owner.removeAnnouncement(added.entry_id);assert.deepEqual(owner.list().entries,[]);
 }finally{await owner.close();}
}));
test('announcement persistence failure publishes no update and refuses subsequent reads until restart',()=>fixture(async db=>{
 const events:Json[]=[],owner=new Announcements(reader(),db,(_method,value)=>events.push(value)),insert=db.insert;
 try{
  await owner.start();db.insert=async()=>{throw Error('injected durable failure');};
  await assert.rejects(owner.addInternal('Lost','description',''),/durable failure/);assert.deepEqual(events,[]);
  assert.throws(()=>owner.list(),/unavailable/);assert.equal((await db.get('native_announcements','catalogue') as any).entries.length,0);
 }finally{db.insert=insert;await owner.close();}
}));
test('close cancels pending remote work but drains a write already accepted by SQLite without publishing to retired clients',()=>fixture(async db=>{
 const events:Json[]=[],owner=new Announcements(reader(),db,(_method,value)=>events.push(value)),insert=db.insert;
 try{
  await owner.start();const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  db.insert=async(...args)=>{entered.resolve();await release.promise;return insert.apply(db,args);};
  const write=owner.addInternal('Accepted','description','');await entered.promise;
  const closing=owner.close();assert.throws(()=>owner.list(),/unavailable/);release.resolve();await write;await closing;
  assert.equal((await db.get('native_announcements','catalogue') as any).entries[0].title,'Accepted');assert.deepEqual(events,[]);
 }finally{db.insert=insert;await owner.close();}
 const remote:typeof fetch=(_url,init)=>new Promise((_resolve,reject)=>{init!.signal!.addEventListener('abort',()=>reject(init!.signal!.reason),{once:true});});
 const second=new Announcements(reader({enable_moonlight:'true'}),db,()=>{},{fetch:remote});
 try{
  await second.start();const pending=second.update({subscriptions:['moonraker']},life()),rejected=assert.rejects(pending,/closing/);
  await until(()=>second.status.pending===1);await second.close();await rejected;assert.equal(second.status.pending,0);
 }finally{await second.close();}
}));
test('development feeds use explicit bounded ordinary files, persist version and refuse escaping symlinks',()=>fixture(async(db,root)=>{
 await writeFile(join(root,'moonraker.xml'),rss(item('moonraker/dev')));
 assert.throws(()=>new Announcements(reader({dev_mode:'true'}),db,()=>{}),/developmentDirectory/);
 const owner=new Announcements(reader({dev_mode:'true'}),db,()=>{},{developmentDirectory:root});
 try{
  await owner.start();assert.equal((await owner.update({subscriptions:['moonraker']},life())).modified,true);
  assert.equal((await owner.update({subscriptions:['moonraker']},life())).modified,false);
  await symlink(join(root,'..','outside.xml'),join(root,'klipper.xml'));const before=owner.list();
  assert.equal((await owner.update({subscriptions:['klipper']},life())).modified,false);assert.deepEqual(owner.list(),before);
 }finally{await owner.close();}
}));
test('invalid persisted catalogue or legacy records fail startup rather than silently losing announcements',()=>fixture(async db=>{
 await db.insert('announcements','000000',{entry_id:'broken'});
 const owner=new Announcements(reader(),db,()=>{});
 try{await assert.rejects(owner.start(),/entry/);assert.throws(()=>owner.list(),/unavailable/);}finally{await owner.close();}
}));

test('a trusted registration cannot overtake an admitted feed write and escape the combined subscription capacity',()=>fixture(async db=>{
 await db.insert('native_announcements','catalogue',{version:1,entries:[],storedFeeds:Array.from({length:29},(_,i)=>'stored'+i),etags:{},localVersions:{}});
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 const remote:typeof fetch=async()=>{entered.resolve();await release.promise;return new Response(rss('','race'));};
 const owner=new Announcements(reader({enable_moonlight:'true'}),db,()=>{},{fetch:remote});
 try{
  await owner.start();assert.equal(owner.feeds().feeds.length,31);
  const pending=owner.feed({name:'race'},false,life());await entered.promise;
  assert.throws(()=>owner.registerFeed('trusted'),e=>e instanceof ApiError&&e.status===409&&e.message==='Announcement updates in progress');
  owner.registerFeed('moonraker');release.resolve();await pending;assert.equal(owner.feeds().feeds.length,32);
  assert.throws(()=>owner.registerFeed('trusted'),/capacity/);await assert.rejects(owner.feed({name:'another'},false,life()),/capacity/);
  assert.equal((await db.get('native_announcements','catalogue') as any).storedFeeds.length,30);
 }finally{release.resolve();await owner.close();}
}));
test('a persisted null catalogue is corruption rather than absence',()=>fixture(async db=>{
 // A top-level insert(null) is intentionally ignored by the pinned database.
 // Batch insertion uses its record codec and actually stores the corrupt row.
 await db.insertBatch('native_announcements',{catalogue:null});assert.equal(await db.namespaceContains('native_announcements','catalogue'),true);const owner=new Announcements(reader(),db,()=>{});
 try{await assert.rejects(owner.start(),/Invalid persisted/);assert.equal(await db.get('native_announcements','catalogue'),null);}
 finally{await owner.close();}
}));
