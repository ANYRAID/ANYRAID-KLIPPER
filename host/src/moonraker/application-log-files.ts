// Fixed application log downloads from pinned Moonraker application.py.
// Original Copyright (C) 2021 Eric Callahan. GPL-3.0-or-later.
import {constants} from 'node:fs';
import {open,realpath,type FileHandle} from 'node:fs/promises';
import {basename,dirname,isAbsolute} from 'node:path';
import {ApiError,authorizedContext,type RpcContext} from './rpc.ts';

export function validateApplicationLogFile(value:unknown):asserts value is string|undefined{
 if(value===undefined)return;
 if(typeof value!=='string'||!value||!isAbsolute(value)||!value.isWellFormed()||Buffer.byteLength(value)>4096||/[\\\0-\x1f\x7f]/u.test(value)||value.endsWith('/'))throw new TypeError('Invalid application log file');
}
export function applicationLogRange(header:string|undefined,size:number):{start:number;end:number;status:200|206|416}{
 // Preserve Tornado's partition/strip/int behavior for real HTTP byte headers,
 // including spaces, plus signs and decimal underscores. Do not round bounds.
 const strip=(value:string)=>value.replace(/^[\t\n\v\f\r\x1c-\x1f \x85\xa0]+|[\t\n\v\f\r\x1c-\x1f \x85\xa0]+$/g,'');
 const whole={start:0,end:size,status:200 as const};if(header===undefined)return whole;
 const equals=header.indexOf('='),unit=strip(equals<0?header:header.slice(0,equals)),value=strip(equals<0?'':header.slice(equals+1));if(unit!=='bytes')return whole;
 const dash=value.indexOf('-'),fields=[strip(dash<0?value:value.slice(0,dash)),strip(dash<0?'':value.slice(dash+1))];
 const parsed=fields.map(field=>field===''?undefined:/^[+-]?[0-9](?:_?[0-9])*$/u.test(field)&&field.replace(/[^0-9]/g,'').length<=4300?BigInt(field.replaceAll('_','')):null);
 if(parsed.includes(null))return whole;let first=parsed[0] as bigint|undefined,last=parsed[1] as bigint|undefined;
 if(last!==undefined){if(first===undefined){if(last!==0n){first=-last;last=undefined;}}else last+=1n;}
 const total=BigInt(size);if(first!==undefined&&first<0n)first=first+total<0n?0n:first+total;
 if(first!==undefined&&(first>=total||last!==undefined&&first>=last)||last===0n)return {...whole,status:416};
 if(last!==undefined&&last>total)last=total;
 const start=Number(first??0n),end=Number(last??total);return {start,end,status:end-start===size?200:206};
}
export interface ApplicationLogDownload {
 readonly name:string;readonly size:number;readonly modifiedMs:number;
 chunks(signal:AbortSignal,start:number,end:number):AsyncGenerator<Buffer>;
}
/** Two fixed aliases, selected only by process/Klippy owners. Keep the opened
 * inode while streaming its initial length; appended bytes belong to the next
 * request. This is a live log, not an immutable print/config snapshot. */
export class ApplicationLogFiles {
 readonly #moonraker:string|undefined;readonly #klippy:()=>unknown;
 readonly #stop=new AbortController();readonly #pending=new Set<Promise<void>>();#closing:Promise<void>|undefined;
 constructor(moonraker:string|undefined,klippy:()=>unknown){validateApplicationLogFile(moonraker);if(typeof klippy!=='function')throw new TypeError('Invalid printer log owner');this.#moonraker=moonraker;this.#klippy=klippy;}
 matches(path:string):boolean{return path==='/server/files/klippy.log'||this.#moonraker!==undefined&&path==='/server/files/moonraker.log';}
 get status(){return {closed:this.#stop.signal.aborted,pending:this.#pending.size,maxDownloads:2,maxFileBytes:1024**3};}
 download(path:string,context:RpcContext,use:(file:ApplicationLogDownload,signal:AbortSignal)=>Promise<void>):Promise<void>{
  if(this.#stop.signal.aborted)return Promise.reject(new ApiError(503,'Log downloads unavailable'));
  if(!this.matches(path))return Promise.reject(new ApiError(404,'Log unavailable'));
  if(this.#pending.size>=2)return Promise.reject(new ApiError(429,'Log download capacity exceeded'));
  const signal=AbortSignal.any([context.signal,this.#stop.signal]),alias=path.endsWith('/moonraker.log')?'moonraker.log':'klippy.log';
  const task=Promise.resolve().then(async()=>{
   signal.throwIfAborted();authorizedContext(context,await context.authorize('server.files.download',{path:alias}));signal.throwIfAborted();
   const selected=alias==='moonraker.log'?this.#moonraker:this.#klippy();
   if(typeof selected!=='string'||!selected)throw new ApiError(404,'Log unavailable');
   try{validateApplicationLogFile(selected);}catch{throw new ApiError(404,'Log unavailable');}
   const filename=selected!;let parent:FileHandle|undefined,file:FileHandle|undefined;
   try{
    const directory=await realpath(dirname(filename));signal.throwIfAborted();parent=await open(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW|constants.O_NONBLOCK);signal.throwIfAborted();
    file=await open('/proc/self/fd/'+parent.fd+'/'+basename(filename),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);signal.throwIfAborted();
    const info=await file.stat();signal.throwIfAborted();if(!info.isFile())throw new ApiError(404,'Log unavailable');
    if(!Number.isSafeInteger(info.size)||info.size<0||info.size>1024**3)throw new ApiError(413,'Log size limit exceeded');
    if(!Number.isFinite(info.mtimeMs)||!Number.isFinite(new Date(info.mtimeMs).valueOf()))throw new ApiError(500,'Invalid log metadata');
    authorizedContext(context,await context.authorize('server.files.download',{path:alias}));signal.throwIfAborted();
    const source=file,size=info.size;
    await use({name:basename(filename),size,modifiedMs:info.mtimeMs,async *chunks(readSignal,start,end){
     if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end>size)throw new ApiError(416,'Invalid log range');
     for(let offset=start;offset<end;){readSignal.throwIfAborted();signal.throwIfAborted();const buffer=Buffer.allocUnsafe(Math.min(65536,end-offset)),result=await source.read(buffer,0,buffer.length,offset);readSignal.throwIfAborted();signal.throwIfAborted();if(!result.bytesRead)throw new ApiError(409,'Log truncated during download');offset+=result.bytesRead;yield buffer.subarray(0,result.bytesRead);}
    }},signal);
   }catch(error){signal.throwIfAborted();if(error instanceof ApiError)throw error;throw new ApiError(404,'Log unavailable');}
   finally{try{await file?.close();}finally{await parent?.close();}}
  });this.#pending.add(task);return task.finally(()=>this.#pending.delete(task));
 }
 close():Promise<void>{this.#stop.abort(new Error('Log owner is stopping'));return this.#closing??=Promise.allSettled([...this.#pending]).then(()=>undefined);}
}
