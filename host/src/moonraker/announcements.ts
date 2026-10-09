// Announcements API follows pinned Moonraker announcements.py; GPL-3.0-or-later.
// Original Copyright (C) 2022 Eric Callahan. The durable catalogue is native.
import {Worker} from 'node:worker_threads';
import {setTimeout as pause} from 'node:timers/promises';
import {constants} from 'node:fs';
import {open,realpath} from 'node:fs/promises';
import {isAbsolute,join,dirname} from 'node:path';
import {workerEntry} from '../runtime/worker-entry.ts';
import {ApiError,type Json} from './rpc.ts';
import {ConfigurationError} from './config-source.ts';
import type {ConfigurationReader} from './config-reader.ts';
import {DatabaseStore} from './database.ts';
import type {DatabaseNamespace} from './database-namespace.ts';
import type {EndpointRegistry} from './endpoints.ts';
import type {AnnouncementFeed,AnnouncementItem} from './announcements-rss.ts';
export interface AnnouncementEntry extends AnnouncementItem,Record<string,Json> {
 dismissed:boolean;date_dismissed:number|null;dismiss_wake:number|null;
 source:'moonlight'|'internal';feed:string;
}
interface Catalogue extends Record<string,Json> {version:1;entries:AnnouncementEntry[];storedFeeds:string[];etags:Record<string,string>;localVersions:Record<string,string>;}
export interface AnnouncementsOptions {
 /** Trusted composition only. Requests cannot supply a host, URL or path. */
 fetch?:typeof fetch;
 developmentDirectory?:string;
}
type Method='notify_announcement_update'|'notify_announcement_dismissed'|'notify_announcement_wake';
const empty=():Catalogue=>({version:1,entries:[],storedFeeds:[],etags:{},localVersions:{}});
const owners=new WeakSet<DatabaseStore>();
// Keep private namespace registrations until the database itself closes.
const registrations=new WeakMap<DatabaseStore,{native:DatabaseNamespace;legacy:boolean}>();
const names=(value:unknown):string=>{
 if(typeof value!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value))throw new ApiError(400,'Invalid announcement feed name');
 return value.toLowerCase();
};
const fields=(value:object,keys:string[])=>Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
function entry(value:unknown):asserts value is AnnouncementEntry {
 if(!value||typeof value!=='object'||!fields(value,['entry_id','url','title','description','priority','date','dismissed','date_dismissed','dismiss_wake','source','feed']))throw new ApiError(503,'Invalid announcement entry');
 const v=value as AnnouncementEntry;
 for(const [key,maximum,nullable] of [['entry_id',4096,false],['url',8192,true],['title',8192,true],['description',65536,true],['priority',128,true],['feed',64,false]] as const){
  const s=v[key];if(nullable&&s===null)continue;
  if(typeof s!=='string'||!s.isWellFormed()||s.includes('\0')||Buffer.byteLength(s)>maximum||!nullable&&!s)throw new ApiError(503,'Invalid announcement entry text');
 }
 if(names(v.feed)!==v.feed||!Number.isFinite(v.date)||typeof v.dismissed!=='boolean'||!['internal','moonlight'].includes(v.source)||[v.date_dismissed,v.dismiss_wake].some(t=>t!==null&&!Number.isFinite(t))||!v.dismissed&&(v.date_dismissed!==null||v.dismiss_wake!==null)||v.dismissed&&v.date_dismissed===null)throw new ApiError(503,'Invalid announcement entry state');
}
function catalogue(value:Json):Catalogue {
 if(!value||typeof value!=='object'||Array.isArray(value)||!fields(value,['version','entries','storedFeeds','etags','localVersions']))throw new ApiError(503,'Invalid persisted announcements');
 const v=value as unknown as Catalogue;
 if(v.version!==1||!Array.isArray(v.entries)||v.entries.length>256||!Array.isArray(v.storedFeeds)||v.storedFeeds.length>30||new Set(v.storedFeeds).size!==v.storedFeeds.length||v.storedFeeds.some(name=>names(name)!==name))throw new ApiError(503,'Invalid persisted announcements');
 const ids=new Set<string>();for(const item of v.entries){entry(item);if(ids.has(item.entry_id))throw new ApiError(503,'Duplicate announcement identity');ids.add(item.entry_id);}
 for(const map of [v.etags,v.localVersions]){
  if(!map||typeof map!=='object'||Array.isArray(map)||Object.keys(map).length>32||Object.entries(map).some(([key,text])=>names(key)!==key||typeof text!=='string'||text.length>1024||/[\r\n\0]/.test(text)))throw new ApiError(503,'Invalid announcement feed version');
 }
 if(Buffer.byteLength(JSON.stringify(v))>524288)throw new ApiError(413,'Announcement catalogue capacity exceeded');
 return structuredClone(v);
}
/** A process component independent of printer generations. Writes become
 * visible only after durability; shutdown cancels remote work and drains an
 * accepted write. Cached reads never wait for network, XML or SQLite. */
export class Announcements {
 readonly #database:DatabaseStore;readonly #options:AnnouncementsOptions;
 readonly #notify:(method:Method,value:Json)=>void;readonly #configured:string[];
 readonly #enabled:boolean;readonly #dev:boolean;
 readonly #lifetime=new AbortController();#namespace:DatabaseNamespace|undefined;
 #catalogue:Catalogue=empty();#ready=false;#closing=false;#fault=false;
 #tail=Promise.resolve();#pending=0;#opening:Promise<void>|undefined;#closed:Promise<void>|undefined;
 #timer:ReturnType<typeof setTimeout>|undefined;#wake:ReturnType<typeof setTimeout>|undefined;
 #worker:Worker|undefined;#lastUpdateError=false;#notifyFailures=0;
 #owns=false;
 constructor(reader:ConfigurationReader,database:DatabaseStore,notify:(method:Method,value:Json)=>void,options:AnnouncementsOptions={}){
  if(!(database instanceof DatabaseStore)||typeof notify!=='function'||options.fetch!==undefined&&typeof options.fetch!=='function'||options.developmentDirectory!==undefined&&(!isAbsolute(options.developmentDirectory)||options.developmentDirectory.includes('\0')))throw new ConfigurationError('Invalid announcements owner');
  this.#database=database;this.#options={...options};this.#notify=notify;
  const section=reader.section('announcements');this.#enabled=section.getBoolean('enable_moonlight',{defaultValue:true});this.#dev=section.getBoolean('dev_mode',{defaultValue:false});
  this.#configured=[...new Set(['moonraker','klipper',...(section.getLists('subscriptions',{defaultValue:[],separators:[',']}) as string[]).filter(Boolean).map(names)])];
  if(this.#configured.length>32)throw new ConfigurationError('Announcement feed capacity exceeded');
  if(this.#dev&&!options.developmentDirectory)throw new ConfigurationError('Announcement dev_mode requires an explicit developmentDirectory');
 }
 get status(){return {ready:this.#ready,closing:this.#closing,failed:this.#fault,pending:this.#pending,entries:this.#catalogue.entries.length,feeds:this.#feeds().length,updateFailed:this.#lastUpdateError,notificationFailures:this.#notifyFailures,workerActive:!!this.#worker};}
 #feeds(){return [...new Set([...this.#configured,...this.#catalogue.storedFeeds])];}
 #active(accepted=false){
  const db=this.#database.status;
  if(!this.#ready||this.#fault||this.#closing&&!accepted||db.closing||db.closed||db.restoreState!=='ready')throw new ApiError(503,'Announcements unavailable');
 }
 start():Promise<void>{if(this.#closing)return Promise.reject(new ApiError(503,'Announcements unavailable'));if(this.#opening)return this.#opening;if(owners.has(this.#database))return Promise.reject(new ApiError(409,'Announcements database already owned'));owners.add(this.#database);this.#owns=true;return this.#opening=this.#start();}
 async #start(){
  let registered=registrations.get(this.#database);
  if(!registered){registered={native:await this.#database.registerLocalNamespace('native_announcements',{forbidden:true}),legacy:false};registrations.set(this.#database,registered);}
  this.#namespace=registered.native;
  const present=await this.#namespace.contains('catalogue');
  const saved=await this.#namespace.get('catalogue');
  if(present&&saved===null)throw new ApiError(503,'Invalid persisted announcements');
  this.#catalogue=saved===null?await this.#importLegacy():catalogue(saved);
  // Prevent public writes from diverging the retained upstream records after
  // importing them. The source namespace remains intact for backup/rollback.
  if(!registered.legacy){await this.#database.registerLocalNamespace('announcements',{forbidden:true});registered.legacy=true;}
  if(this.#feeds().length>32)throw new ApiError(503,'Announcement feed capacity exceeded');
  const now=Date.now()/1000;let changed=saved===null;
  for(const value of this.#catalogue.entries)if(value.dismissed&&value.dismiss_wake!==null&&value.dismiss_wake-now<10){value.dismissed=false;value.date_dismissed=value.dismiss_wake=null;changed=true;}
  if(changed)await this.#namespace.insert('catalogue',this.#catalogue as unknown as Json);
  if(this.#closing)return;this.#ready=true;this.#scheduleWake();
 }
 async #importLegacy():Promise<Catalogue>{
  const read=async(namespace:string,key?:string)=>{try{return await this.#database.get(namespace,key);}catch(error){if(error instanceof ApiError&&error.status===404)return null;throw error;}};
  const saved=await read('announcements'),settings=await read('moonraker','announcements');const value=empty();
  if(saved!==null){if(typeof saved!=='object'||Array.isArray(saved))throw new ApiError(503,'Invalid legacy announcement namespace');for(const key of Object.keys(saved).sort()){if(!/^[0-9A-F]{6,}$/.test(key))throw new ApiError(503,'Invalid legacy announcement key');const item=saved[key];entry(item);value.entries.push(structuredClone(item));}}
  if(settings!==null){
   if(typeof settings!=='object'||Array.isArray(settings))throw new ApiError(503,'Invalid legacy announcement subscriptions');
   const feeds=settings.stored_feeds??[];if(!Array.isArray(feeds)||feeds.some(name=>typeof name!=='string'))throw new ApiError(503,'Invalid legacy announcement subscriptions');value.storedFeeds=(feeds as string[]).map(names);
   for(const [name,record] of Object.entries(settings))if(name!=='stored_feeds'&&record&&typeof record==='object'&&!Array.isArray(record)&&record.etag!==undefined){const feed=names(name);if(typeof record.etag!=='string')throw new ApiError(503,'Invalid legacy announcement ETag');value.etags[feed]=record.etag;}
  }
  return catalogue(value);
 }
 /** Begin periodic updates only after listening. Network unavailability does
  * not gate startup, readiness, motion or cached announcements. */
 beginUpdates(){this.#active();if(this.#timer)return;this.#scheduleUpdate(0);}
 #scheduleUpdate(delay:number){
  if(this.#closing||this.#fault)return;
  this.#timer=setTimeout(()=>{this.#timer=undefined;if(this.#closing)return;
   void this.update({},this.#lifetime.signal).catch(()=>{this.#lastUpdateError=true;}).finally(()=>this.#scheduleUpdate(1800000));
  },delay);this.#timer.unref();
 }
 list(params:Readonly<Record<string,Json>>={}){
  this.#active();let include=params.include_dismissed??true;
  if(typeof include==='string'&&['true','false'].includes(include.toLowerCase()))include=include.toLowerCase()==='true';
  if(typeof include!=='boolean')throw new ApiError(400,'Invalid include_dismissed');
  return {entries:this.#entries(this.#catalogue,include),feeds:this.#feeds()};
 }
 feeds(){this.#active();return {feeds:this.#feeds()};}
 /** Trusted component registration, like pinned register_feed. It adds no
  * public mutation route or printer authority and protects deletion by name. */
 registerFeed(value:string){
  if(this.#closing||this.#fault)throw new ApiError(503,'Announcements unavailable');
  const name=names(value);if(this.#feeds().includes(name))return;
  if(this.#pending)throw new ApiError(409,'Announcement updates in progress');
  if(this.#feeds().length>=32)throw new ApiError(409,'Announcement feed capacity exceeded');this.#configured.push(name);
 }
 #entries(value:Catalogue,include=true){return structuredClone(value.entries.filter(e=>include||!e.dismissed).sort((a,b)=>b.date-a.date));}
 #emit(method:Method,value:Json){if(this.#closing)return;try{this.#notify(method,structuredClone(value));}catch{this.#notifyFailures++;}}
 #enqueue<T>(signal:AbortSignal,run:(value:Catalogue,signal:AbortSignal)=>Promise<T>):Promise<T>{
  this.#active();signal.throwIfAborted();if(this.#pending>=16)throw new ApiError(429,'Announcement mutation queue full');
  const lifetime=AbortSignal.any([signal,this.#lifetime.signal]);this.#pending++;
  const task=this.#tail.then(()=>{this.#active(true);lifetime.throwIfAborted();return run(structuredClone(this.#catalogue),lifetime);}).finally(()=>{this.#pending--;});
  this.#tail=task.then(()=>{},()=>{});return task;
 }
 async #commit(value:Catalogue,signal:AbortSignal){
  if(new Set([...this.#configured,...value.storedFeeds]).size>32)throw new ApiError(409,'Announcement feed capacity exceeded');
  catalogue(value);signal.throwIfAborted();
  try{await this.#namespace!.insert('catalogue',value as unknown as Json);}catch(error){this.#fault=true;clearTimeout(this.#timer);clearTimeout(this.#wake);throw error;}
  this.#catalogue=value;this.#scheduleWake();
 }
 dismiss(params:Readonly<Record<string,Json>>,signal:AbortSignal){
  const id=params.entry_id,wake=params.wake_time??null;
  if(typeof id!=='string'||!id||Buffer.byteLength(id)>4096||wake!==null&&(!Number.isSafeInteger(wake)||Math.abs(wake as number)>31536000))throw new ApiError(400,'Invalid announcement dismissal');
  return this.#enqueue(signal,async(value,life)=>{
   const target=value.entries.find(e=>e.entry_id===id);if(!target)throw new ApiError(404,'Announcement not found');
   if(!target.dismissed){target.dismissed=true;target.date_dismissed=Date.now()/1000;target.dismiss_wake=wake===null?null:target.date_dismissed+(wake as number);
    await this.#commit(value,life);this.#emit('notify_announcement_dismissed',{entry_id:id});}
   return {entry_id:id};
  });
 }
 #scheduleWake(){
  clearTimeout(this.#wake);this.#wake=undefined;if(this.#closing||this.#fault)return;
  const times=this.#catalogue.entries.filter(e=>e.dismissed&&e.dismiss_wake!==null).map(e=>e.dismiss_wake!);
  if(!times.length)return;
  const earliest=Math.min(...times),delay=Math.min(2147483647,Math.max(0,(earliest-Date.now()/1000)*1000));
  this.#wake=setTimeout(()=>{this.#wake=undefined;
   if(this.#closing)return;
   void this.#enqueue(this.#lifetime.signal,async(value,life)=>{
    const now=Date.now()/1000,ids:string[]=[];
    for(const e of value.entries)if(e.dismissed&&e.dismiss_wake!==null&&e.dismiss_wake<=now){e.dismissed=false;e.date_dismissed=e.dismiss_wake=null;ids.push(e.entry_id);}
    if(ids.length){await this.#commit(value,life);for(const id of ids)this.#emit('notify_announcement_wake',{entry_id:id});}else this.#scheduleWake();
   }).catch(()=>{this.#lastUpdateError=true;if(!this.#closing&&!this.#fault){this.#wake=setTimeout(()=>this.#scheduleWake(),1000);this.#wake.unref();}});
  },delay);this.#wake.unref();
 }
 update(params:Readonly<Record<string,Json>>,signal:AbortSignal):Promise<{entries:AnnouncementEntry[];modified:boolean}>{
  const supplied=params.subscriptions;
  const selected=supplied===undefined?undefined:typeof supplied==='string'?supplied.split(',').map(v=>v.trim()):supplied;
  if(selected!==undefined&&(!Array.isArray(selected)||selected.length>32||selected.some(name=>typeof name!=='string')))throw new ApiError(400,'Invalid announcement subscriptions');
  const chosen=selected===undefined?undefined:[...new Set((selected as string[]).map(names))];
  return this.#enqueue(signal,async(value,life)=>{
   const feeds=this.#feeds(),requested=chosen??feeds;
   if(requested.some(name=>!feeds.includes(name)))throw new ApiError(400,'Unknown announcement subscription');
   let modified=false,versions=false;this.#lastUpdateError=false;
   for(const name of requested){
    const result=await this.#refresh(value,name,life);modified=modified||result.modified;versions=versions||result.versions;
   }
   if(modified||versions)await this.#commit(value,life);
   const entries=this.#entries(this.#catalogue);if(modified)this.#emit('notify_announcement_update',{entries});
   return {entries,modified};
  });
 }
 feed(params:Readonly<Record<string,Json>>,remove:boolean,signal:AbortSignal){
  const name=names(params.name);
  return this.#enqueue(signal,async(value,life)=>{
   if(remove){
    if(!value.storedFeeds.includes(name))throw new ApiError(400,'Announcement feed is not stored');
    if(this.#configured.includes(name))throw new ApiError(400,'Cannot remove configured announcement feed');
    value.storedFeeds=value.storedFeeds.filter(v=>v!==name);
    const old=value.entries.length;value.entries=value.entries.filter(e=>e.feed!==name);delete value.etags[name];delete value.localVersions[name];
    await this.#commit(value,life);if(old!==value.entries.length)this.#emit('notify_announcement_update',{entries:this.#entries(value)});
    return {feed:name,action:'removed'};
   }
   if(this.#feeds().includes(name))return {feed:name,action:'skipped'};
   if(this.#feeds().length>=32)throw new ApiError(409,'Announcement feed capacity exceeded');
   value.storedFeeds.push(name);const changed=await this.#refresh(value,name,life);await this.#commit(value,life);
   if(changed.modified)this.#emit('notify_announcement_update',{entries:this.#entries(value)});
   return {feed:name,action:'added'};
  });
 }
 async addInternal(title:string,description:string,url:string,priority='normal',feed='internal'):Promise<AnnouncementEntry>{
  const name=names(feed),now=Date.now()/1000;
  return this.#enqueue(this.#lifetime.signal,async(value,life)=>{
   // Preserve second-resolution upstream IDs without overwriting a collision.
   const id=name+'/'+new Date(now*1000).toISOString().slice(0,19);
   if(value.entries.some(e=>e.entry_id===id))throw new ApiError(409,'Announcement identity already exists');
   const result:AnnouncementEntry={entry_id:id,title,description,url,priority,date:now,dismissed:false,date_dismissed:null,dismiss_wake:null,source:'internal',feed:name};
   entry(result);value.entries.push(result);await this.#commit(value,life);this.#emit('notify_announcement_update',{entries:this.#entries(value)});return structuredClone(result);
  });
 }
 removeAnnouncement(id:string){
  return this.#enqueue(this.#lifetime.signal,async(value,life)=>{
   if(!value.entries.some(e=>e.entry_id===id))throw new ApiError(404,'Announcement not found');
   value.entries=value.entries.filter(e=>e.entry_id!==id);await this.#commit(value,life);this.#emit('notify_announcement_update',{entries:this.#entries(value)});
  });
 }
 async #refresh(value:Catalogue,name:string,signal:AbortSignal):Promise<{modified:boolean;versions:boolean}>{
  if(!this.#enabled&&!this.#dev)return {modified:false,versions:false};
  let fetched:{xml:string;version:string|null}|null;
  try{fetched=this.#dev?await this.#local(name,Object.hasOwn(value.localVersions,name)?value.localVersions[name]:undefined,signal):await this.#remote(name,Object.hasOwn(value.etags,name)?value.etags[name]:undefined,signal);}
  catch(error){signal.throwIfAborted();this.#lastUpdateError=true;return {modified:false,versions:false};}
  if(!fetched)return {modified:false,versions:false};
  let parsed:AnnouncementFeed|null;
  try{parsed=await this.#parse(fetched.xml,signal);}catch{signal.throwIfAborted();this.#lastUpdateError=true;return {modified:false,versions:false};}
  if(!parsed)return {modified:false,versions:false};
  const valid=new Set(parsed.items.map(e=>e.entry_id)),old=value.entries.length,ids=new Set(value.entries.map(e=>e.entry_id));
  // A feed may only prune its own announcements, including prefix changes.
  value.entries=value.entries.filter(e=>e.source!=='moonlight'||e.feed!==name||!parsed!.prefix||!e.entry_id.startsWith(parsed!.prefix)||valid.has(e.entry_id));
  let modified=old!==value.entries.length;
  for(const item of parsed.items)if(!ids.has(item.entry_id)){
   const next:AnnouncementEntry={...item,dismissed:false,date_dismissed:null,dismiss_wake:null,source:'moonlight',feed:name};
   entry(next);value.entries.push(next);ids.add(item.entry_id);modified=true;
  }
  catalogue(value);
  const map=this.#dev?value.localVersions:value.etags,previous=Object.hasOwn(map,name)?map[name]:null;
  if(fetched.version===null)delete map[name];else map[name]=fetched.version;
  return {modified,versions:previous!==fetched.version};
 }
 async #remote(name:string,etag:string|undefined,signal:AbortSignal){
  const life=AbortSignal.any([signal,AbortSignal.timeout(10000)]);
  for(let attempt=0;;attempt++){
   life.throwIfAborted();try{return await this.#remoteAttempt(name,etag,life);}catch(error){life.throwIfAborted();if(attempt===4)throw error;await pause(500,undefined,{signal:life});}
  }
 }
 async #remoteAttempt(name:string,etag:string|undefined,life:AbortSignal){
  let response:Response|undefined;
  try{
   // Fixed official origin and strict feed basename; redirects cannot become SSRF.
   response=await (this.#options.fetch??fetch)('https://arksine.github.io/moonlight/assets/'+name+'.xml',{signal:life,redirect:'error',headers:{Accept:'application/xml',...etag?{'If-None-Match':etag}:{}}});
   if(response.status===304)return null;if(!response.ok)throw Error('Announcement feed unavailable');
   const advertised=response.headers.get('content-length');if(advertised!==null&&(!/^\d+$/.test(advertised)||Number(advertised)>1048576))throw Error('Announcement feed too large');
   const version=response.headers.get('etag');if(version!==null&&(version.length>1024||/[\r\n\0]/.test(version)))throw Error('Invalid announcement ETag');
   const reader=response.body?.getReader();if(!reader)return null;const chunks:Uint8Array[]=[];let size=0;
   try{for(;;){life.throwIfAborted();const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>1048576)throw Error('Announcement feed too large');chunks.push(next.value);}}
   finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
   return {xml:new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size)),version};
  }finally{await response?.body?.cancel().catch(()=>{});}
 }
 async #local(name:string,previous:string|undefined,signal:AbortSignal){
  const directory=await realpath(this.#options.developmentDirectory!);signal.throwIfAborted();
  const path=join(directory,name+'.xml'),physical=await realpath(path);if(dirname(physical)!==directory)throw Error('Announcement development path escaped');
  const handle=await open(path,constants.O_RDONLY|constants.O_NONBLOCK|constants.O_NOFOLLOW);
  try{
   const info=await handle.stat({bigint:true});if(!info.isFile()||info.size>1048576n)throw Error('Invalid announcement development file');
   const version=info.dev+':'+info.ino+':'+info.size+':'+info.mtimeNs+':'+info.ctimeNs;if(version===previous)return null;
   const bytes=Buffer.alloc(Number(info.size)+1);let size=0;
   for(;;){signal.throwIfAborted();const {bytesRead}=await handle.read(bytes,size,bytes.length-size,null);if(!bytesRead)break;size+=bytesRead;if(size===bytes.length)throw Error('Announcement development file changed');}
   const after=await handle.stat({bigint:true});if(after.dev!==info.dev||after.ino!==info.ino||after.size!==info.size||after.mtimeNs!==info.mtimeNs||after.ctimeNs!==info.ctimeNs)throw Error('Announcement development file changed');
   return {xml:new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,size)),version};
  }finally{await handle.close();}
 }
 async #parse(xml:string,signal:AbortSignal):Promise<AnnouncementFeed|null>{
  signal.throwIfAborted();
  const worker=new Worker(workerEntry('./announcements-parse-worker.ts',import.meta.url),{workerData:{xml,now:Date.now()/1000},execArgv:[],resourceLimits:{maxOldGenerationSizeMb:32,maxYoungGenerationSizeMb:8,stackSizeMb:2}});
  this.#worker=worker;
  try{return await new Promise<AnnouncementFeed|null>((resolve,reject)=>{
   const timeout=setTimeout(()=>reject(Error('Announcement parsing deadline exceeded')),2000);
   const abort=()=>reject(signal.reason??Error('Announcement parsing cancelled'));signal.addEventListener('abort',abort,{once:true});
   const cleanup=()=>{clearTimeout(timeout);signal.removeEventListener('abort',abort);};
   worker.once('message',(result:{ok:boolean;value:AnnouncementFeed|null})=>{cleanup();result.ok?resolve(result.value):reject(Error('Invalid announcement RSS'));});
   worker.once('error',error=>{cleanup();reject(error);});worker.once('exit',code=>{cleanup();reject(Error('Announcement parser exited '+code));});
   if(signal.aborted)abort();
  });}finally{await worker.terminate();if(this.#worker===worker)this.#worker=undefined;}
 }
 register(registry:EndpointRegistry){
  const releases:(()=>void)[]=[];
  try{
   releases.push(registry.register({endpoint:'/server/announcements/list',methods:['GET']},params=>this.list(params)));
   releases.push(registry.register({endpoint:'/server/announcements/dismiss',methods:['POST']},(params,_verb,context)=>this.dismiss(params,context.signal)));
   releases.push(registry.register({endpoint:'/server/announcements/update',methods:['POST']},(params,_verb,context)=>this.update(params,context.signal)));
   releases.push(registry.register({endpoint:'/server/announcements/feed',methods:['POST','DELETE']},(params,verb,context)=>this.feed(params,verb==='DELETE',context.signal)));
   releases.push(registry.register({endpoint:'/server/announcements/feeds',methods:['GET']},()=>this.feeds()));
  }catch(error){for(const release of releases)release();throw error;}
  return ()=>{for(const release of releases)release();};
 }
 close():Promise<void>{
  if(this.#closed)return this.#closed;this.#closing=true;clearTimeout(this.#timer);clearTimeout(this.#wake);this.#lifetime.abort(new Error('Announcements closing'));
  return this.#closed=(async()=>{await this.#opening?.catch(()=>{});await this.#tail;this.#ready=false;if(this.#owns){owners.delete(this.#database);this.#owns=false;}})();
 }
}
