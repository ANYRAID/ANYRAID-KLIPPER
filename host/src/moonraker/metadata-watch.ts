import {setTimeout as delay} from 'node:timers/promises';
import {watch,type FSWatcher} from 'node:fs';
import type {FileHandle} from 'node:fs/promises';
import type {MetadataFiles,MetadataObservation} from './metadata-files.ts';
/** Bounded non-recursive watches on already validated directory descriptors. */
export class MetadataDirectoryWatches {
 #entries=new Map<string,{identity:string;watcher:FSWatcher}>();#closed=false;#change:()=>void;#error:(error:Error)=>void;#limit:number;
 constructor(root:FileHandle,change:()=>void,error:(error:Error)=>void,limit=1024){if(typeof change!=='function'||typeof error!=='function')throw new TypeError('Metadata watch callbacks required');if(!Number.isSafeInteger(limit)||limit<1||limit>4096)throw new RangeError('Invalid metadata watch capacity');this.#change=change;this.#error=error;this.#limit=limit;this.#add('',root,'root');}
 get count(){return this.#entries.size;}
 #add(path:string,source:FileHandle,identity:string){
  if(this.#closed)return;if(this.#entries.size>=this.#limit)throw new Error('Metadata directory watch capacity exceeded');
  const watcher=watch(`/proc/self/fd/${source.fd}/.`,{persistent:false},()=>{if(!this.#closed)this.#change();}),entry={identity,watcher};this.#entries.set(path,entry);
  watcher.on('error',error=>{if(this.#entries.get(path)===entry)this.#error(error);});watcher.on('close',()=>{if(this.#entries.get(path)===entry){this.#entries.delete(path);this.#change();}});
 }
 async touch(path:string,source:FileHandle):Promise<void>{
  if(this.#closed)return;if(path===''){if(!this.#entries.has(''))this.#add('',source,'root');return;}const status=await source.stat({bigint:true});if(this.#closed)return;const identity=`${status.dev}:${status.ino}`,previous=this.#entries.get(path);if(previous?.identity===identity)return;
  if(previous){this.#entries.delete(path);previous.watcher.close();}this.#add(path,source,identity);
 }
 retain(paths:ReadonlySet<string>):void{for(const [path,entry] of this.#entries)if(!paths.has(path)){this.#entries.delete(path);entry.watcher.close();}}
 close():void{if(this.#closed)return;this.#closed=true;const entries=[...this.#entries.values()];this.#entries.clear();for(const entry of entries)entry.watcher.close();}
}
export interface MetadataMonitorOptions {debounceMs?:number;intervalMs?:number;maxDirectories?:number;}
/** Events are hints, not reliable filenames. One reconciliation at a time and one
 * dirty bit coalesce storms. Periodic passes cover events lost by the OS. */
export class MetadataMonitor {
 #files:MetadataFiles;#options:Required<MetadataMonitorOptions>;#abort=new AbortController();#release:MetadataObservation|undefined;#onFault:(()=>void)|undefined;#timer:ReturnType<typeof setTimeout>|undefined;#interval:ReturnType<typeof setInterval>|undefined;#running:Promise<void>|undefined;#closing:Promise<void>|undefined;#dirty=false;#phase:'new'|'running'|'faulted'|'closed'='new';#passes=0;#lastError:string|undefined;
 constructor(files:MetadataFiles,options:MetadataMonitorOptions={},onFault?:()=>void){if(onFault!==undefined&&typeof onFault!=='function')throw new TypeError('Invalid metadata fault callback');this.#onFault=onFault;this.#files=files;this.#options={debounceMs:options.debounceMs??100,intervalMs:options.intervalMs??30000,maxDirectories:options.maxDirectories??1024};for(const [value,min,max] of [[this.#options.debounceMs,1,60000],[this.#options.intervalMs,10,3600000],[this.#options.maxDirectories,1,4096]])if(!Number.isSafeInteger(value)||value<min||value>max)throw new RangeError('Invalid metadata monitor options');}
 get status(){return {phase:this.#phase,watchedDirectories:this.#files.watchedDirectories,passes:this.#passes,active:!!this.#running,dirty:this.#dirty,lastError:this.#lastError};}
 async start():Promise<void>{
  if(this.#phase!=='new')throw new Error('Metadata monitor already started');this.#phase='running';
  try{this.#release=this.#files.observe(()=>this.#hint(),error=>this.#fail(error),this.#options.maxDirectories);await this.#pump();if(this.#phase!=='running')throw new Error('Metadata monitor stopped during startup');this.#interval=setInterval(()=>this.#hint(),this.#options.intervalMs);this.#interval.unref();}catch(error){this.#fail(error);throw error;}
 }
 #hint(){if(this.#phase!=='running')return;this.#dirty=true;if(this.#running||this.#timer)return;this.#timer=setTimeout(()=>{this.#timer=undefined;void this.#pump().catch(()=>{});},this.#options.debounceMs);this.#timer.unref();}
 #pump():Promise<void>{if(this.#running)return this.#running;if(this.#phase!=='running')return Promise.reject(new Error('Metadata monitor is stopped'));this.#dirty=false;const task=(async()=>{for(let attempt=0;;attempt++){try{await this.#files.scanDiscovered(this.#abort.signal);this.#abort.signal.throwIfAborted();this.#release?.healthy();this.#passes++;return;}catch(error){if(this.#abort.signal.aborted)throw error;if(attempt<2&&transient(error)){await delay(250,undefined,{signal:this.#abort.signal});continue;}this.#fail(error);throw error;}}})();this.#running=task.finally(()=>{this.#running=undefined;if(this.#dirty)this.#hint();});return this.#running;}
 #fail(error:unknown){if(this.#phase==='closed'||this.#phase==='faulted')return;this.#phase='faulted';this.#lastError=error instanceof Error?error.message:String(error);this.#release?.fault();this.#clear();this.#abort.abort(error);try{this.#onFault?.();}catch{this.#lastError+='; status update failed';}}
 #clear(){if(this.#timer)clearTimeout(this.#timer);if(this.#interval)clearInterval(this.#interval);this.#timer=undefined;this.#interval=undefined;this.#dirty=false;this.#release?.();this.#release=undefined;}
 close():Promise<void>{if(this.#closing)return this.#closing;this.#phase='closed';this.#clear();this.#abort.abort(new Error('Metadata monitor closing'));this.#closing=Promise.allSettled(this.#running?[this.#running]:[]).then(()=>{});return this.#closing;}
}

function transient(error:unknown):boolean{const messages=new Set(['Metadata file queue is full','Metadata discovery already running','G-code file unavailable or symlink forbidden','Metadata source changed during read','Metadata source changed during extraction','Metadata source binding changed','Metadata source changed before selection','Metadata source changed during selection','Metadata scan was superseded','Metadata preparation did not complete']);for(let i=0;i<4&&error instanceof Error;i++,error=error.cause)if(messages.has(error.message))return true;return false;}
