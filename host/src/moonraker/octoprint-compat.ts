// Pinned octoprint_compat.py, Copyright (C) 2021 Nickolas Grigoriadis.
// GPL-3.0-or-later. All device/file operations delegate to the existing owners.
import {ApiError,type Json,type RpcContext} from './rpc.ts';
import type {ConfigurationReader} from './config-reader.ts';
import type {EndpointRegistry} from './endpoints.ts';
import type {KlippyState} from './metadata.ts';
import {roundHistoryDecimal} from './history-round.ts';
import {printFilename} from './print-api.ts';
export interface OctoprintOwners {
 state():KlippyState;
 query(objects:Record<string,Json>,context:RpcContext):Promise<Record<string,Json>>;
 command(script:string,context:RpcContext):Promise<void>;
 select(filename:string,context:RpcContext):Promise<void>;
}
function object(value:Json|undefined):Record<string,Json>{return value!==null&&typeof value==='object'&&!Array.isArray(value)?value:{};}
function boolean(value:Json|undefined,defaultValue=false):boolean{if(value===undefined)return defaultValue;if(typeof value==='boolean')return value;if(typeof value==='string'&&['true','false'].includes(value.toLowerCase()))return value.toLowerCase()==='true';throw new ApiError(400,'Unable to convert boolean argument');}
/** HTTP compatibility metadata is never an authorization grant. Inner native
 * operations reauthorize through the canonical handlers in the original scope. */
export class OctoprintCompatibility {
 readonly enableUfp:boolean;readonly #webcam:Record<string,Json>;readonly #versionInfo:Readonly<{server:string;api:string;text:string}>;readonly #versionResponse:Promise<Json>;readonly #owners:OctoprintOwners;
 #closed=false;#commandFailures=0;#heaters:Record<string,Json>={};
 constructor(reader:ConfigurationReader,version:string,owners:OctoprintOwners){
  const config=reader.section('octoprint_compat');this.enableUfp=config.getBoolean('enable_ufp',{defaultValue:true});
  this.#webcam={flipH:config.getBoolean('flip_h',{defaultValue:false}),flipV:config.getBoolean('flip_v',{defaultValue:false}),rotate90:config.getBoolean('rotate_90',{defaultValue:false}),streamUrl:config.get('stream_url',{defaultValue:'/webcam/?action=stream'}),webcamEnabled:config.getBoolean('webcam_enabled',{defaultValue:true})};
  this.#versionInfo=Object.freeze({server:'1.5.0',api:'0.1',text:'OctoPrint (Moonraker '+version+')'});this.#versionResponse=Promise.resolve(this.#versionInfo);this.#owners=owners;
 }
 get status(){return {closed:this.#closed,commandFailures:this.#commandFailures};}
 #check(context:RpcContext){context.signal.throwIfAborted();if(this.#closed)throw new ApiError(503,'OctoPrint component closed');}
 async #snapshot(context:RpcContext){
  this.#check(context);const state=this.#owners.state();if(state!=='ready')return {state:state==='startup'||state==='disconnected'?'Offline':'Error',heaters:this.#heaters};
  const initial=await this.#owners.query({heaters:null,print_stats:null},context);this.#check(context);
  const sensors=object(initial.heaters).available_sensors,selection:Record<string,Json>={};
  if(Array.isArray(sensors))for(const name of sensors){if(typeof name!=='string'||name.length>256)throw new ApiError(503,'Invalid heater catalog');selection[name]=null;}
  const heaters=Object.keys(selection).length?await this.#owners.query(selection,context):{};this.#check(context);this.#heaters=heaters;
  // Do not serve a late ready result after an owner retires during the queries.
  const current=this.#owners.state();return {state:current!=='ready'?(current==='startup'||current==='disconnected'?'Offline':'Error'):({standby:'Operational',printing:'Printing',paused:'Paused',complete:'Operational'}[String(object(initial.print_stats).state??'standby')]??'Error'),heaters};
 }
 handle(path:string,params:Readonly<Record<string,Json>>,context:RpcContext):Promise<Json>{
  // Version metadata is immutable for this component generation. Reuse its
  // already resolved response; still check each caller before returning it.
  try{this.#check(context);return path==='/api/version'?this.#versionResponse:this.#handle(path,params,context);}catch(error){return Promise.reject(error);}
 }
 async #handle(path:string,params:Readonly<Record<string,Json>>,context:RpcContext):Promise<Json>{
  if(path==='/api/server')return {server:'1.5.0',safemode:this.#owners.state()==='ready'?null:'settings'};
  if(path==='/api/login'||path==='/api/currentuser')return {_is_external_client:false,_login_mechanism:'apikey',name:'_api',active:true,user:true,admin:true,apikey:null,permissions:[],groups:['admins','users']};
  if(path==='/api/settings')return {plugins:this.enableUfp?{UltimakerFormatPackage:{align_inline_thumbnail:false,inline_thumbnail:false,inline_thumbnail_align_value:'left',inline_thumbnail_scale_value:'50',installed:true,installed_version:'0.2.2',scale_inline_thumbnail:false,state_panel_thumbnail:true}}:{},feature:{sdSupport:false,temperatureGraph:false},webcam:{...this.#webcam}};
  if(path==='/api/printer/command'){
   context.nativeGenerationSignal?.throwIfAborted();
   const commands=params.commands??[];if(!Array.isArray(commands)||commands.length>64||commands.some(c=>typeof c!=='string'||!c.isWellFormed()||Buffer.byteLength(c)>65536))throw new ApiError(400,'Expected bounded G-code commands');
   for(const command of commands){this.#check(context);context.nativeGenerationSignal?.throwIfAborted();try{await this.#owners.command(command as string,context);}catch(error){this.#check(context);context.nativeGenerationSignal?.throwIfAborted();if(error instanceof ApiError&&[401,403].includes(error.status))throw error;this.#commandFailures=Math.min(Number.MAX_SAFE_INTEGER,this.#commandFailures+1);}}
   return {};
  }
  if(path==='/api/files/moonraker'){
   context.nativeGenerationSignal?.throwIfAborted();
   if(params.command!=='select')throw new ApiError(400,'Unsupported Command');
   if(typeof params.relative_path!=='string')throw new ApiError(400,'Missing relative_path');
   const relative=params.relative_path.replace(/^\/+|\/+$/g,''),at=relative.indexOf('/');if(at<1)throw new ApiError(400,'Expected file root and path');
   if(!boolean(params.print))return null;
   if(relative.slice(0,at)!=='gcodes')throw new ApiError(400,"File must be located in the 'gcodes' root");
   const filename=relative.slice(at+1);if(filename.startsWith('/')||filename.includes('\\'))throw new ApiError(400,'Invalid selected file path');await this.#owners.select(printFilename(filename),context);this.#check(context);return null;
  }
  const snapshot=await this.#snapshot(context),state=snapshot.state;
  if(path==='/api/job')return {job:{file:{name:null},estimatedPrintTime:null,filament:{length:null},user:null},progress:{completion:null,filepos:null,printTime:null,printTimeLeft:null,printTimeOrigin:null},state};
  if(path==='/api/printerprofiles')return {profiles:{_default:{id:'_default',name:'Default',color:'default',model:'Default',default:true,current:true,heatedBed:Object.hasOwn(snapshot.heaters,'heater_bed'),heatedChamber:Object.hasOwn(snapshot.heaters,'chamber'),axes:{x:{speed:6000,inverted:false},y:{speed:6000,inverted:false},z:{speed:6000,inverted:false},e:{speed:300,inverted:false}}}}};
  if(path==='/api/printer'){
   const temperature:Record<string,Json>={};for(const [heater,value]of Object.entries(snapshot.heaters)){
    let name:string;if(heater.startsWith('extruder')){const suffix=heater.slice(8);name='tool'+(/^[+-]?\d+$/.test(suffix)?BigInt(suffix).toString():0);}else if(heater==='heater_bed')name='bed';else continue;
    const data=object(value),actual=data.temperature??0,target=data.target??0;if(typeof actual!=='number'||!Number.isFinite(actual)||typeof target!=='number'||!Number.isFinite(target))throw new ApiError(503,'Invalid heater temperature');temperature[name]={actual:roundHistoryDecimal(actual,2),offset:0,target};
   }
   return {temperature,state:{text:state,flags:{operational:!['Error','Offline'].includes(state),paused:state==='Paused',printing:state==='Printing',cancelling:state==='Cancelling',pausing:false,error:state==='Error',ready:state==='Operational',closedOrError:['Error','Offline'].includes(state)}}};
  }
  throw new ApiError(404,'Not Found');
 }
 register(registry:EndpointRegistry):()=>void{
  const releases:(()=>void)[]=[];try{for(const path of ['/api/version','/api/server','/api/login','/api/currentuser','/api/settings','/api/job','/api/printer','/api/printer/command','/api/printerprofiles','/api/files/moonraker'])releases.push(registry.register({endpoint:path,methods:path==='/api/login'||path==='/api/printer/command'||path==='/api/files/moonraker'?['POST']:['GET'],transports:['http'],wrapResult:false,...path==='/api/files/moonraker'?{pathParameter:'relative_path'}:{}},(params,_verb,context)=>this.handle(path,params,context)));}
  catch(error){for(const release of releases.reverse())release();throw error;}
  return ()=>{this.#closed=true;this.#heaters={};for(const release of releases.splice(0).reverse())release();};
 }
}
