import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export interface FatBlockDevice {sectors:number;writeProtected:boolean;readSector(sector:number,signal:AbortSignal):Promise<Uint8Array>;writeSector(sector:number,data:Uint8Array,signal:AbortSignal):Promise<void>;sync(signal:AbortSignal):Promise<void>;}
const limit=64*1024*1024;
export class FatFSError extends Error {readonly code:number;constructor(code:number){super('FatFs error '+code);this.code=code;}}
/** Each filesystem owns a separate FatFs process: the vendored single-volume,
 * non-reentrant C library never shares state with other cards or blocks Node. */
export class FatFS {
 readonly #child:ChildProcessWithoutNullStreams;readonly #device:FatBlockDevice;readonly #exit:Promise<void>;readonly #reader:AsyncIterator<Buffer|string>;
 #lifetime=new AbortController();#buffer=Buffer.alloc(0);#tail:Promise<unknown>=Promise.resolve();#closed=false;#pending=0;
 private constructor(device:FatBlockDevice,helper:string){
  this.#device=device;this.#child=spawn(helper,[],{stdio:['pipe','pipe','pipe']});this.#reader=this.#child.stdout[Symbol.asyncIterator]();
  this.#child.stdin.on('error',()=>{});this.#child.stderr.resume();this.#child.on('error',()=>{this.#closed=true;});
  this.#exit=new Promise(resolve=>this.#child.once('close',()=>{this.#closed=true;resolve();}));
 }
 static async mount(device:FatBlockDevice,signal:AbortSignal,helper=fileURLToPath(new URL('../../build/fatfs-helper',import.meta.url))):Promise<FatFS>{
  signal.throwIfAborted();if(!Number.isInteger(device.sectors)||device.sectors<1||device.sectors>0xffffffff||typeof device.writeProtected!=='boolean')throw new RangeError('Unsupported FatFs disk geometry');
  const fs=new FatFS({sectors:device.sectors,writeProtected:device.writeProtected,readSector:device.readSector.bind(device),writeSector:device.writeSector.bind(device),sync:device.sync.bind(device)},helper),data=Buffer.alloc(9);data.writeUInt32LE(device.sectors);data[4]=Number(device.writeProtected);const now=new Date(),year=Math.max(1980,Math.min(2107,now.getFullYear()));data.writeUInt32LE((((year-1980)<<25)|((now.getMonth()+1)<<21)|(now.getDate()<<16)|(now.getHours()<<11)|(now.getMinutes()<<5)|(now.getSeconds()>>>1))>>>0,5);
  try{await fs.#operation('M',data,signal);return fs;}catch(error){await fs.close();throw error;}
 }
 async #read(size:number):Promise<Buffer>{
  const parts:Buffer[]=[];let remaining=size;
  while(remaining){if(!this.#buffer.length){const next=await this.#reader.next();if(next.done)throw new Error('FatFs helper exited before response');this.#buffer=Buffer.from(next.value);if(this.#buffer.length>limit+65541)throw new Error('FatFs helper output overflow');}
   const take=Math.min(remaining,this.#buffer.length);parts.push(this.#buffer.subarray(0,take));this.#buffer=this.#buffer.subarray(take);remaining-=take;
  }return Buffer.concat(parts,size);
 }
 async #send(op:string,data:Uint8Array){const header=Buffer.alloc(5);header[0]=op.charCodeAt(0);header.writeUInt32LE(data.length,1);for(const bytes of [header,data])await new Promise<void>((resolve,reject)=>this.#child.stdin.write(bytes,error=>error?reject(error):resolve()));}
 #operation(op:string,data:Uint8Array,signal:AbortSignal):Promise<Buffer>{
  if(this.#pending>=8)return Promise.reject(new Error('FatFs queue full'));const snapshot=Buffer.from(data);this.#pending++;const bounded=AbortSignal.any([signal,this.#lifetime.signal,AbortSignal.timeout(120000)]);
  const task=this.#tail.then(async()=>{
   bounded.throwIfAborted();if(this.#closed)throw new Error('FatFs is closed');const abort=()=>{this.#closed=true;this.#child.kill('SIGKILL');};bounded.addEventListener('abort',abort,{once:true});
   try{
    await this.#send(op,snapshot);
    for(;;){const h=await this.#read(5),kind=String.fromCharCode(h[0]),length=h.readUInt32LE(1);if(length>limit)throw new Error('FatFs response too large');const body=await this.#read(length);bounded.throwIfAborted();
     if(kind==='=')return Buffer.from(body);
     if(kind==='!'){if(length!==4)throw new Error('Malformed FatFs error');throw new FatFSError(body.readUInt32LE());}
     if(kind==='s'){if(length)throw new Error('Malformed FatFs sync');await this.#device.sync(bounded);bounded.throwIfAborted();await this.#send('=',new Uint8Array());continue;}
     if(!['r','w'].includes(kind)||length<8)throw new Error('Unexpected FatFs request');
     const sector=body.readUInt32LE(),count=body.readUInt32LE(4);if(!count||count>128||sector+count>this.#device.sectors||length!==(kind==='r'?8:8+count*512))throw new Error('Invalid FatFs sector request');
     if(kind==='r'){const out=Buffer.alloc(count*512);for(let i=0;i<count;i++){bounded.throwIfAborted();const bytes=await this.#device.readSector(sector+i,bounded);if(bytes.length!==512)throw new Error('Incomplete FatFs sector');out.set(bytes,i*512);}bounded.throwIfAborted();await this.#send('=',out);}
     else{if(this.#device.writeProtected)throw new Error('FatFs disk is write protected');for(let i=0;i<count;i++){bounded.throwIfAborted();await this.#device.writeSector(sector+i,Buffer.from(body.subarray(8+i*512,8+(i+1)*512)),bounded);}bounded.throwIfAborted();await this.#send('=',new Uint8Array());}
    }
   }catch(error){if(error instanceof FatFSError&&[4,5,6,7,8,10].includes(error.code))throw error;abort();await this.#exit;if(bounded.aborted)throw bounded.reason;throw error;}finally{bounded.removeEventListener('abort',abort);}
  });this.#tail=task.catch(()=>{});return task.finally(()=>{this.#pending--;});
 }
 #path(path:string){if(typeof path!=='string'||!path||path.length>255||!/^[\x20-\x7e]+$/.test(path)||path.startsWith('/')||path.includes(':')||path.includes('\\')||path.split('/').some(p=>!p||p==='.'||p==='..'))throw new TypeError('Expected relative ASCII FAT path');return Buffer.from(path);}
 readFile(path:string,signal:AbortSignal){return this.#operation('R',this.#path(path),signal);}
 writeFile(path:string,bytes:Uint8Array,signal:AbortSignal){const name=this.#path(path);if(!(bytes instanceof Uint8Array)||bytes.length>limit)throw new RangeError('FatFs file exceeds 64 MiB');const header=Buffer.alloc(4);header.writeUInt32LE(name.length);return this.#operation('W',Buffer.concat([header,name,bytes]),signal).then(()=>{});}
 remove(path:string,signal:AbortSignal){return this.#operation('D',this.#path(path),signal).then(()=>{});}
 async stat(path:string,signal:AbortSignal){const bytes=await this.#operation('S',this.#path(path),signal);if(bytes.length!==9){await this.close();throw new Error('Malformed FatFs stat');}return {size:bytes.readUInt32LE(),modified:bytes.readUInt32LE(4),attributes:bytes[8]};}
 async close(){this.#closed=true;this.#lifetime.abort(new Error('FatFs closed'));this.#child.kill('SIGKILL');await this.#exit;await this.#tail;}
}
