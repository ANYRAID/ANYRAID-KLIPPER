// Central webcam configuration follows pinned Moonraker webcam.py; GPL-3.0-or-later.
import {createHash,randomUUID} from 'node:crypto';
import {ApiError,type Json,validateJson} from './rpc.ts';
import type {ConfigurationReader} from './config-reader.ts';
import type {DatabaseStore} from './database.ts';
import type {DatabaseNamespace} from './database-namespace.ts';
import type {EndpointRegistry} from './endpoints.ts';
const defaults={enabled:true,icon:'mdiWebcam',aspect_ratio:'4:3',target_fps:15,target_fps_idle:5,location:'printer',service:'mjpegstreamer',snapshot_url:'',flip_horizontal:false,flip_vertical:false,rotation:0};
const mapping:Record<string,string>={name:'name',service:'service',target_fps:'targetFps',stream_url:'urlStream',snapshot_url:'urlSnapshot',flip_horizontal:'flipX',flip_vertical:'flipY',enabled:'enabled',target_fps_idle:'targetFpsIdle',aspect_ratio:'aspectRatio',icon:'icon',location:'location',rotation:'rotation',extra_data:'extra_data'};
export type Webcam=Record<string,Json>&{name:string;uid:string;source:'config'|'database';stream_url:string;snapshot_url:string};
function camera(params:Readonly<Record<string,Json>>,uid:string,source:'config'|'database',previous?:Webcam):Webcam{
 const value:Record<string,Json>={...defaults,...previous,name:params.name??previous?.name??'',stream_url:params.stream_url??previous?.stream_url??'',extra_data:previous?.extra_data??{}};
 for(const name of Object.keys(mapping))if(Object.hasOwn(params,name))value[name]=structuredClone(params[name]);
 for(const [name,defaultValue] of Object.entries({...defaults,name:'',stream_url:''})){
  let v=value[name];if(typeof defaultValue==='boolean'){if(typeof v==='string'&&['true','false'].includes(v.toLowerCase()))v=v.toLowerCase()==='true';if(typeof v!=='boolean')throw new ApiError(400,'Invalid webcam '+name);}
  else if(typeof defaultValue==='number'){if(typeof v==='string'&&/^[+-]?\d+$/.test(v))v=Number(v);if(typeof v!=='number'||!Number.isSafeInteger(v))throw new ApiError(400,'Invalid webcam '+name);}
  else if(typeof v!=='string'||v.length>8192||v.includes('\0'))throw new ApiError(400,'Invalid webcam '+name);value[name]=v;
 }
 if(!value.name||!previous&&!Object.hasOwn(params,'stream_url'))throw new ApiError(400,'Webcam name and stream_url required');
 if(![0,90,180,270].includes(value.rotation as number)||!/^\d+:\d+$/.test(value.aspect_ratio as string))throw new ApiError(400,'Invalid webcam rotation or aspect_ratio');
 validateJson(value.extra_data);if(!value.extra_data||typeof value.extra_data!=='object'||Array.isArray(value.extra_data)||Buffer.byteLength(JSON.stringify(value.extra_data))>65536)throw new ApiError(400,'Invalid webcam extra_data');
 return {...value,uid,source} as Webcam;
}
function uuid5(namespace:string,name:string){const raw=Buffer.from(namespace.replaceAll('-',''),'hex');if(raw.length!==16)throw new ApiError(500,'Invalid webcam instance identity');const digest=createHash('sha1').update(raw).update(name).digest().subarray(0,16);digest[6]=(digest[6]&15)|80;digest[8]=(digest[8]&63)|128;const h=digest.toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;}
/** Durable serialized mutations; reads use isolated in-memory snapshots. */
export class Webcams {
 readonly #db:DatabaseStore;readonly #reader:ConfigurationReader;readonly #configured:Record<string,Json>[]=[];readonly #notify:(event:Json)=>void;
 readonly #abort=new AbortController();readonly #probes=new Set<Promise<Json>>();
 #store?:DatabaseNamespace;#cams=new Map<string,Webcam>();#tail:Promise<unknown>=Promise.resolve();#pending=0;#ready=false;#closing=false;#closed=false;#fault=false;
 constructor(reader:ConfigurationReader,db:DatabaseStore,notify:(event:Json)=>void){this.#reader=reader;this.#db=db;this.#notify=notify;
  for(const section of reader.prefixSections('webcam ')){const config=reader.section(section),entry:Record<string,Json>={name:section.slice(7).trim(),stream_url:config.get('stream_url')};
   for(const [name,value] of Object.entries(defaults))entry[name]=typeof value==='boolean'?config.getBoolean(name,{defaultValue:value}):typeof value==='number'?config.getInt(name,{defaultValue:value}):config.get(name,{defaultValue:value});
   camera(entry,'','config');this.#configured.push(entry);
  }
 }
 async start(){
  if(this.#closed)throw new ApiError(503,'Webcams closed');const metadata=await this.#db.registerLocalNamespace('native_webcam_identity',{forbidden:true}),saved=await metadata.get('instance_uuid');
  let instance:string;if(saved===null){instance=randomUUID();await metadata.insert('instance_uuid',instance);}else{if(typeof saved!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(saved))throw new ApiError(500,'Invalid stored webcam identity');instance=saved;}
  this.#store=await this.#db.registerLocalNamespace('webcams',{parseKeys:false});
  for(const config of this.#configured){const entry=camera(config,uuid5(instance,'moonraker.webcam.'+config.name),'config');this.#cams.set(entry.name,entry);}
  const persisted=await this.#store.all();if(!persisted||typeof persisted!=='object'||Array.isArray(persisted))throw new ApiError(500,'Invalid webcam namespace');
  for(const [uid,data] of Object.entries(persisted)){try{
   if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('Invalid record');const params:Record<string,Json>={stream_url:''};for(const [name,dbName] of Object.entries(mapping))if(Object.hasOwn(data,dbName))params[name]=data[dbName];if(params.rotation===undefined&&data.rotate!==undefined)params.rotation=data.rotate;
   const entry=camera(params,uid,'database');if(this.#cams.has(entry.name)){this.#reader.warn('Ignored stored webcam with configured name: '+entry.name);continue;}
   if([...this.#cams.values()].some(cam=>cam.uid===uid)){entry.uid=randomUUID();try{await this.#store.moveBatch([uid],[entry.uid]);}catch(error){this.#fault=true;throw error;}}
   this.#cams.set(entry.name,entry);
  }catch(error){if(this.#fault)throw error;this.#reader.warn('Ignored invalid persisted webcam record');}}
  this.#ready=true;
 }
 #active(accepted=false){const state=this.#db.status;if(!this.#ready||this.#closed||this.#closing&&!accepted||this.#fault||state.closed||state.closing||state.restoreState!=='ready')throw new ApiError(503,'Webcams unavailable');}
 #record(cam:Webcam){const data:Record<string,Json>={};for(const [name,dbName] of Object.entries(mapping))data[dbName]=structuredClone(cam[name]);return data;}
 #lookup(params:Readonly<Record<string,Json>>,required=true){let cam:Webcam|undefined;if(Object.hasOwn(params,'uid')){if(typeof params.uid!=='string')throw new ApiError(400,'Invalid webcam uid');cam=[...this.#cams.values()].find(c=>c.uid===params.uid);if(!cam)throw new ApiError(404,'Webcam UID not found');}
  else{if(typeof params.name!=='string')throw new ApiError(400,'Webcam name required');cam=this.#cams.get(params.name);if(required&&!cam)throw new ApiError(404,'Webcam not found');}return cam;
 }
 list(){this.#active();return {webcams:[...this.#cams.values()].map(cam=>structuredClone(cam))};}
 get(params:Readonly<Record<string,Json>>){this.#active();return {webcam:structuredClone(this.#lookup(params)!)};}
 mutate(params:Readonly<Record<string,Json>>,remove=false):Promise<Json>{
  this.#active();if(this.#pending>=32)throw new ApiError(429,'Webcam mutation queue full');const captured=structuredClone(params);this.#pending++;
  const task=this.#tail.then(async()=>{this.#active(true);const old=this.#lookup(captured,remove);if(old?.source==='config')throw new ApiError(400,'Cannot modify configuration webcam');
   const entry=remove?old!:camera(captured,old?.uid??randomUUID(),'database',old);const conflict=this.#cams.get(entry.name);if(conflict&&conflict.uid!==entry.uid)throw new ApiError(400,'Webcam name already exists');
   if(!old&&this.#cams.size>=1024)throw new ApiError(409,'Webcam capacity exceeded');
   try{if(remove)await this.#store!.delete(entry.uid);else await this.#store!.insert(entry.uid,this.#record(entry));}catch(error){this.#fault=true;throw error;}
   if(old)this.#cams.delete(old.name);if(!remove)this.#cams.set(entry.name,entry);const result={webcam:structuredClone(entry)};
   this.#notify({webcams:[...this.#cams.values()].map(cam=>structuredClone(cam))});return result;
  }).finally(()=>{this.#pending--;});this.#tail=task.catch(()=>{});return task;
 }
 test(params:Readonly<Record<string,Json>>):Promise<Json>{
  this.#active();if(this.#probes.size>=4)throw new ApiError(429,'Webcam probe capacity exceeded');const cam=this.get(params).webcam;
  const task=(async()=>{const resolve=(value:string)=>{if(!value)return '';return /^\w+:\/\/[^/]+/.test(value)?value:'http://127.0.0.1/'+value.replace(/^\/+/, '');};
   const result={name:cam.name,snapshot_reachable:false,snapshot_url:resolve(cam.snapshot_url),stream_url:resolve(cam.stream_url)};
   if(/^https?:\/\//.test(result.snapshot_url)){const signal=AbortSignal.any([this.#abort.signal,AbortSignal.timeout(1000)]);let response:Response|undefined;
    try{response=await fetch(result.snapshot_url,{signal});if(response.ok){let size=0;const reader=response.body?.getReader();if(reader)try{for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>8388608)throw new Error('Snapshot exceeds probe limit');}}finally{await reader.cancel();reader.releaseLock();}result.snapshot_reachable=true;}}
    catch{result.snapshot_reachable=false;}finally{await response?.body?.cancel().catch(()=>{});}
   }return result;
  })();this.#probes.add(task);void task.finally(()=>this.#probes.delete(task)).catch(()=>{});return task;
 }
 register(endpoints:EndpointRegistry){const release=[endpoints.register({endpoint:'/server/webcams/test',methods:['POST']},params=>this.test(params)),endpoints.register({endpoint:'/server/webcams/list',methods:['GET']},()=>this.list()),endpoints.register({endpoint:'/server/webcams/item',methods:['GET','POST','DELETE']},(params,verb)=>verb==='GET'?this.get(params):this.mutate(params,verb==='DELETE'))];return ()=>{for(const fn of release)fn();};}
 async close(){this.#closing=true;this.#abort.abort();await Promise.allSettled([this.#tail,...this.#probes]);this.#closed=true;}
}
