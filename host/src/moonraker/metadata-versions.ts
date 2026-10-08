import {MetadataHeadStorage} from './metadata-head-storage.ts';
import {metadataScanIntent,type MetadataScanIntent} from './metadata-intents.ts';
import {validateMetadataFilename} from './file-metadata.ts';
export interface MetadataVersion {readonly version:1;readonly id:string;readonly sequence:string;readonly filename:string;readonly state:'pending'|'selected'|'invalidated';readonly scanId:string|null;}
const MAX_SEQUENCE=(1n<<64n)-1n;
function record(input:unknown,id:string):MetadataVersion{
 const value=input as MetadataVersion;
 if(!value||Object.keys(value).length!==6||value.version!==1||value.id!==id||typeof value.sequence!=='string'||!/^[1-9][0-9]{0,19}$/.test(value.sequence)||BigInt(value.sequence)>MAX_SEQUENCE||id!=='mv-'+value.sequence)throw new Error('Invalid metadata version record');
 validateMetadataFilename(value.filename);
 if(value.state==='invalidated'){if(value.scanId!==null)throw new Error('Invalid metadata invalidation');}
 else if(!['pending','selected'].includes(value.state)||typeof value.scanId!=='string'||!/^scan-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.scanId))throw new Error('Invalid metadata version state');
 return Object.freeze({...value});
}
/** A mutation can be durable despite an error. Never infer rollback from failure. */
export class MetadataVersionWriteError extends Error {
 readonly candidate:MetadataVersion;
 constructor(candidate:MetadataVersion,cause:unknown){super('Metadata version write requires recovery',{cause});this.candidate=candidate;}
}
/** Atomically replace checksummed heads after data and directory sync.
 * At least the latest record (including invalidation) for each file is retained,
 * so recovery never falls back to a retired selection or reuses a published sequence. */
export class MetadataVersions {
 #store:MetadataHeadStorage;#current=new Map<string,MetadataVersion>();#sequence=0n;#maxFiles:number;#maxPending:number;
 #tail:Promise<unknown>=Promise.resolve();#pending=new Set<Promise<unknown>>();#fault:unknown;#closed=false;#closing:Promise<void>|undefined;
 private constructor(store:MetadataHeadStorage,maxFiles:number,maxPending:number){this.#store=store;this.#maxFiles=maxFiles;this.#maxPending=maxPending;}
 static async open(directory:string,options:{maxFiles?:number;maxPending?:number}={}):Promise<MetadataVersions>{
  const count=options.maxFiles??1024,pending=options.maxPending??4;if(!Number.isSafeInteger(count)||count<1||count>4096||!Number.isSafeInteger(pending)||pending<1||pending>16)throw new RangeError('Invalid metadata version capacity');
  const store=await MetadataHeadStorage.open(directory,record),instance=new MetadataVersions(store,count,pending);
  for(const item of store.entries()){instance.#current.set(item.filename,item);const seq=BigInt(item.sequence);if(seq>instance.#sequence)instance.#sequence=seq;}return instance;
 }
 get status(){return {closed:this.#closed,faulted:this.#fault!==undefined,pending:this.#pending.size,files:this.#current.size,sequence:this.#sequence.toString(),staging:this.#store.staging};}
 #readable():void{if(this.#closed||this.#fault!==undefined)throw new Error('Metadata versions require an open recovered store');}
 current(filename:string):MetadataVersion|undefined{this.#readable();validateMetadataFilename(filename);return this.#current.get(filename);}
 entries():readonly MetadataVersion[]{this.#readable();return Object.freeze([...this.#current.values()]);}
 isCurrent(value:MetadataVersion):boolean{this.#readable();return this.#current.get(value.filename)===value;}
 #run<T>(operation:()=>Promise<T>):Promise<T>{if(this.#closed)return Promise.reject(new Error('Metadata versions are closed'));if(this.#pending.size>=this.#maxPending)return Promise.reject(new Error('Metadata version queue is full'));const task=this.#tail.then(()=>{if(this.#fault!==undefined)throw new Error('Metadata versions require recovery',{cause:this.#fault});return operation();});this.#tail=task.catch(()=>{});this.#pending.add(task);return task.finally(()=>this.#pending.delete(task));}
 async #write(filename:string,state:MetadataVersion['state'],scanId:string|null,signal:AbortSignal):Promise<MetadataVersion>{
  signal.throwIfAborted();validateMetadataFilename(filename);const previous=this.#current.get(filename);if(!previous&&this.#current.size>=this.#maxFiles)throw new Error('Metadata version file capacity exceeded');if(this.#sequence===MAX_SEQUENCE)throw new Error('Metadata version sequence exhausted');
  const sequence=(this.#sequence+1n).toString(),candidate=record({version:1,id:'mv-'+sequence,sequence,filename,state,scanId},'mv-'+sequence);
  try{
   await this.#store.write(candidate,signal);this.#current.set(filename,candidate);this.#sequence=BigInt(sequence);return candidate;
  }catch(error){this.#fault=error;throw new MetadataVersionWriteError(candidate,error);}
 }
 /** Accept only a newly allocated durable scan intent; callers must never reuse
  * an old scan ID as a new generation. */
 begin(intent:MetadataScanIntent,signal:AbortSignal):Promise<MetadataVersion>{return this.#run(async()=>{const value=metadataScanIntent(intent);if(this.#current.get(value.filename)?.scanId===value.id)throw new Error('Scan generation already current');return this.#write(value.filename,'pending',value.id,signal);});}
 select(expected:MetadataVersion,signal:AbortSignal):Promise<MetadataVersion|null>{return this.#run(async()=>{signal.throwIfAborted();if(!expected||this.#current.get(expected.filename)!==expected||expected.state!=='pending')return null;return this.#write(expected.filename,'selected',expected.scanId,signal);});}
 invalidate(filename:string,signal:AbortSignal):Promise<MetadataVersion>{return this.#run(()=>this.#write(filename,'invalidated',null,signal));}
 /** Read-only predicate. The lifecycle owner serializes version changes with
  * retirement and must use fresh scan IDs; absence alone is not authorization. */
 canRetire(intent:MetadataScanIntent):boolean{const current=this.current(intent.filename);return current!==undefined&&current.scanId!==intent.id;}
 close():Promise<void>{if(this.#closing)return this.#closing;this.#closed=true;this.#closing=Promise.allSettled([...this.#pending]).then(()=>this.#store.close());return this.#closing;}
}
