import type {FileHandle} from 'node:fs/promises';
import type {BigIntStats} from 'node:fs';
export interface GCodeFileIdentity {device:string;inode:string;size:string;mtimeNs:string;ctimeNs:string;}
export interface GCodeFileBatch {readonly script:string;readonly lines:number;readonly endOffset:number;}
/** Owns an already authorized, open regular file. The storage owner must prevent
 * concurrent writes. Metadata checks detect ordinary mutation, not hostile rewrites. */
export class GCodeFileReader {
 #decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
 #file:FileHandle;#snapshot:BigIntStats;#buffer=Buffer.alloc(0);#readOffset=0;#position=0;
 #pending:GCodeFileBatch|undefined;#reading=false;#closed=false;#eof=false;#fault:unknown;
 #closing:Promise<void>|undefined;#onClosed:(()=>void)|undefined;
 #chunk:Buffer;#batchLines:number;
 private constructor(file:FileHandle,snapshot:BigIntStats,chunkBytes:number,batchLines:number,onClosed?:()=>void){this.#onClosed=onClosed;this.#file=file;this.#snapshot=snapshot;this.#chunk=Buffer.alloc(chunkBytes);this.#batchLines=batchLines;}
 static async adopt(file:FileHandle,options:{chunkBytes?:number;batchLines?:number;maxBytes?:number;onClosed?:()=>void}={}):Promise<GCodeFileReader>{
  const chunk=options.chunkBytes??65536,lines=options.batchLines??128,max=options.maxBytes??16*1024**3;
  if(!Number.isSafeInteger(chunk)||chunk<1||chunk>65536||!Number.isSafeInteger(lines)||lines<1||lines>128||!Number.isSafeInteger(max)||max<1)throw new RangeError('Invalid G-code file limits');
  if(options.onClosed!==undefined&&typeof options.onClosed!=='function')throw new TypeError('Invalid file close observer');
  const stat=await file.stat({bigint:true});if(!stat.isFile()||stat.size>BigInt(max)||stat.size>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('G-code source must be a bounded regular file');
  return new GCodeFileReader(file,stat,chunk,lines,options.onClosed);
 }
 /** Identity of the authorized descriptor at adoption; storage still owns write exclusion. */
 get identity():Readonly<GCodeFileIdentity>{const s=this.#snapshot;return Object.freeze({device:s.dev.toString(),inode:s.ino.toString(),size:s.size.toString(),mtimeNs:s.mtimeNs.toString(),ctimeNs:s.ctimeNs.toString()});}
 get status(){return {size:Number(this.#snapshot.size),readOffset:this.#readOffset,position:this.#position,pending:this.#pending!==undefined,eof:this.#eof,closed:this.#closed,fault:this.#fault};}
 async #unchanged():Promise<void>{
  const now=await this.#file.stat({bigint:true}),was=this.#snapshot;
  if(now.dev!==was.dev||now.ino!==was.ino||now.size!==was.size||now.mtimeNs!==was.mtimeNs||now.ctimeNs!==was.ctimeNs)throw new Error('G-code file changed during printing');
 }
 async assertUnchanged(signal:AbortSignal):Promise<void>{signal.throwIfAborted();if(this.#closed||this.#fault)throw new Error('G-code file unavailable');await this.#unchanged();signal.throwIfAborted();}
 /** At most one batch may be outstanding; commit only after dispatch succeeds. */
 async next(signal:AbortSignal):Promise<GCodeFileBatch|null>{
  signal.throwIfAborted();if(this.#closed||this.#fault)throw new Error('G-code file is unavailable',{cause:this.#fault});
  if(this.#pending||this.#reading)throw new Error('G-code file batch is already outstanding');
  if(this.#eof)return null;this.#reading=true;
  try{
   while(true){
    signal.throwIfAborted();if(this.#closed)throw new Error('G-code file closed during read');
    let bytes=0,lines=0;
    while(lines<this.#batchLines){
     const newline=this.#buffer.indexOf(10,bytes);if(newline<0)break;
     if(newline-bytes>65536)throw new Error('G-code file line limit exceeded');
     bytes=newline+1;lines++;
    }
    if(lines){
     // Decode a complete batch once. Never split a UTF-8 sequence between batches.
     let text=this.#decoder.decode(this.#buffer.subarray(0,bytes));
     if(text.includes('\r'))text=text.replace(/\r\n/g,'\n');
     const script=text.slice(0,-1);if(/[\r\0]/.test(script))throw new Error('Invalid G-code file line');
     if(script.length>1048576)throw new Error('G-code file batch limit exceeded');
     this.#buffer=this.#buffer.subarray(bytes);
     this.#pending=Object.freeze({script,lines,endOffset:this.#position+bytes});return this.#pending;
    }
    if(this.#buffer.length>65536)throw new Error('G-code file line limit exceeded');
    if(this.#readOffset===Number(this.#snapshot.size)){
     await this.#unchanged();signal.throwIfAborted();if(this.#closed)throw new Error('G-code file closed during EOF check');if(this.#buffer.length)throw new Error('Unterminated G-code file line');
     this.#eof=true;return null;
    }
    await this.#unchanged();signal.throwIfAborted();
    const count=Math.min(this.#chunk.length,Number(this.#snapshot.size)-this.#readOffset);
    const {bytesRead}=await this.#file.read(this.#chunk,0,count,this.#readOffset);signal.throwIfAborted();
    if(this.#closed)throw new Error('G-code file closed during read');if(bytesRead===0)throw new Error('Unexpected G-code file EOF');
    this.#readOffset+=bytesRead;this.#buffer=Buffer.concat([this.#buffer,this.#chunk.subarray(0,bytesRead)]);
   }
  }catch(error){this.#fault=error;throw error;}finally{this.#reading=false;}
 }
 commit(batch:GCodeFileBatch):void{
  if(this.#closed||this.#fault||batch!==this.#pending)throw new Error('Invalid G-code file batch commit');
  this.#position=batch.endOffset;this.#pending=undefined;
 }
 close():Promise<void>{
  if(this.#closing)return this.#closing;const deferred=Promise.withResolvers<void>();this.#closing=deferred.promise;
  this.#closed=true;this.#pending=undefined;this.#buffer=Buffer.alloc(0);
  void Promise.resolve().then(()=>this.#file.close()).then(()=>{try{this.#onClosed?.();this.#onClosed=undefined;deferred.resolve();}catch(error){deferred.reject(error);}},deferred.reject);return deferred.promise;
 }
}
