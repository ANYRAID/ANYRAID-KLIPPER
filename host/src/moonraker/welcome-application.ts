// Full pinned application.py WelcomeHandler and assets/welcome.html ownership.
// Original Copyright (C) 2020 Eric Callahan. GPL-3.0-or-later.
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {ApiError,type Json} from './rpc.ts';
import {MoonrakerTemplateFactory,type MoonrakerRenderableTemplate} from './template-factory.ts';
import type {NetworkAuthorization} from './server.ts';
import type {ApiKeyAuthorization} from './api-key-authorization.ts';
import type {AnnouncementEntry} from './announcements.ts';
import {safeRedirectTarget} from './redirect-target.ts';
export interface WelcomeMachineView {sudo_requested:boolean;sudo_request_message:string;linux_user:string;local_ip:string;service_name:string;hostname:string;}
export interface WelcomeApplicationOptions {
 templates():MoonrakerTemplateFactory|undefined;
 authorization():ApiKeyAuthorization|undefined;
 authorize(context:NetworkAuthorization):unknown|Promise<unknown>;
 information():Record<string,Json>;
 stateMessage(information:Record<string,Json>):string;
 corsEnabled():boolean;
 machine():WelcomeMachineView;
 announcements():readonly AnnouncementEntry[];
}
let source:Promise<string>|undefined;
/** One immutable, verified bundled source; no request paths or per-request I/O. */
export function loadWelcomeSource():Promise<string>{
 if(source)return source;source=(async()=>{const file=await open(new URL('../../assets/moonraker/welcome.html',import.meta.url),constants.O_RDONLY|constants.O_NONBLOCK);
  try{const info=await file.stat();if(!info.isFile()||info.size>65536)throw Error('Invalid welcome asset');const chunks:Buffer[]=[];let size=0;for(;;){const bytes=Buffer.allocUnsafe(Math.min(65536,65537-size)),read=await file.read(bytes,0,bytes.length,null);if(!read.bytesRead)break;size+=read.bytesRead;if(size>65536)throw Error('Invalid welcome asset');chunks.push(bytes.subarray(0,read.bytesRead));}const bytes=Buffer.concat(chunks,size);if(createHash('sha256').update(bytes).digest('hex')!=='fe91ee967ef43dab8e425c175fbbf1e4d3cd7f093f5f330a8098740acf482c2f')throw Error('Invalid welcome asset');return bytes.toString('utf8');}
  finally{await file.close();}
 })();void source.catch(()=>{source=undefined;});return source;
}
/** Keep the complete original template. Only presentation security and the
 * configured endpoint prefix change; no replacement page or private globals. */
export function welcomeTemplate(source:string):string{
 for(const text of['document.querySelector(`#${id}`);','setClickable("{{ id }}");','pwd_req.open("POST", "/machine/sudo/password");'])if(source.split(text).length!==2)throw new ApiError(500,'Invalid welcome template');
 return '{% autoescape true %}'+source.replace('document.querySelector(`#${id}`);','document.getElementById(id);').replace('setClickable("{{ id }}");','setClickable({{ id|tojson }});').replace('pwd_req.open("POST", "/machine/sudo/password");','pwd_req.open("POST", {{ sudo_password_endpoint|tojson }});')+'{% endautoescape %}';
}
/** UI rendering shares the private process factory when present. An application
 * without it owns a restricted UI-only instance, never reads guessed secrets. */
export class WelcomeApplication {
 readonly #source:string;readonly #options:WelcomeApplicationOptions;
 #owned:MoonrakerTemplateFactory|undefined;#template:MoonrakerRenderableTemplate|undefined;#closed=false;
 constructor(source:string,options:WelcomeApplicationOptions){this.#source=welcomeTemplate(source);this.#options=options;}
 #handle(){if(this.#closed)throw new ApiError(503,'Application is closed');if(!this.#template){const factory=this.#options.templates()??(this.#owned??=MoonrakerTemplateFactory.createPublicUi());this.#template=factory.createUiTemplate(this.#source);}return this.#template;}
 async render(context:NetworkAuthorization):Promise<string>{
  if(this.#closed)throw new ApiError(503,'Application is closed');context.signal.throwIfAborted();let authorized=true;
  try{await this.#options.authorize(context);}catch(error){context.signal.throwIfAborted();if(!(error instanceof ApiError)||error.status<400||error.status>599)throw error;authorized=false;}
  context.signal.throwIfAborted();const auth=this.#options.authorization(),info=this.#options.information(),cors=this.#options.corsEnabled(),state=String(info.klippy_state),summary:string[]=[];
  // Existing metadata may contain1024large warnings. Stop before cloning or
  // serializing an unbounded UI payload on the print process event loop.
  if(!Array.isArray(info.warnings))throw new ApiError(503,'Invalid welcome context');let warningBytes=0;for(const warning of info.warnings){if(typeof warning!=='string'||(warningBytes+=6*Buffer.byteLength(warning)+4)>1048576)throw new ApiError(503,'Welcome context exceeds capacity');}
  if(auth){summary.push(authorized?'Your device is authorized to access Moonraker\'s API.':'Your device is not authorized to access Moonraker\'s API. This is normal if you intend to use API Key authentication or log in as an authenticated user. Otherwise you need to add your IP address to the trusted_clients option in the [authorization] section of moonraker.conf.');summary.push(cors?'CORS is enabled. Cross origin requests will be allowed for origins that match one of the patterns specified in the cors_domains option of the [authorization] section.':'All cross origin requests will be blocked by the browser. The cors_domains option in [authorization] must be configured to enable CORS.');}
  else summary.push('The native authorization component is not enabled. Access follows the configured application authorization policy.');
  summary.push(state==='disconnected'?'Moonraker is not currently connected to Klipper. Make sure that the klipper service has successfully started and that its unix socket is enabled.':'Klipper reports '+(this.#options.stateMessage(info)||state).toLowerCase());
  const announcements=this.#options.announcements().map(item=>({...item,url:safeRedirectTarget(item.url)??'#'}));
  const payload={remote_ip:auth?auth.requestAddress(context)??'unknown':context.request.socket.remoteAddress??'unknown',authorized,cors_enabled:cors,version:info.moonraker_version,ws_count:info.websocket_count,klippy_state:state,warnings:info.warnings,summary,announcements,...this.#options.machine(),sudo_password_endpoint:(context.routePrefix??'')+'/machine/sudo/password'};
  const json=JSON.stringify(payload);if(Buffer.byteLength(json)>1048576)throw new ApiError(503,'Welcome context exceeds capacity');const html=await this.#handle().renderAsync(json,{signal:context.signal});context.signal.throwIfAborted();if(this.#closed)throw new ApiError(503,'Application is closed');return html;
 }
 close(){if(this.#closed)return;this.#closed=true;this.#template?.close();this.#template=undefined;this.#owned?.close();this.#owned=undefined;}
}
