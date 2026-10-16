import {constants} from 'node:fs';
import {open,mkdir,realpath,lstat,readlink,symlink,rmdir,readdir,rename,type FileHandle} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {resolve,isAbsolute,join,dirname,basename} from 'node:path';
const directoryNames=['database','config','logs','gcodes'] as const;
const fileNames=['moonraker.secrets','certs/moonraker.cert','certs/moonraker.key'] as const;
export interface LegacyProductPaths {
 dataPath:string;directories:Record<typeof directoryNames[number],string>;
 files?:Partial<Record<typeof fileNames[number],string>>;
}
interface Binding {relative:string;physical:string;kind:'directory'|'file';dev:string;ino:string;}
interface Receipt {schema:1;phase:'preparing'|'published';dataPath:string;rootDev:string;rootIno:string;certsDev:string|null;certsIno:string|null;bindings:Binding[];}
const native=createRequire(import.meta.url)('../../build/sealed-file.node') as {lockDirectory(fd:number):void};
const validPath=(path:unknown):path is string=>typeof path==='string'&&path!=='/'&&isAbsolute(path)&&resolve(path)===path&&path.isWellFormed()&&!/[\0\r\n]/u.test(path)&&Buffer.byteLength(path)<=4096;
function declaration(options:LegacyProductPaths):Array<{relative:string;physical:string;kind:'directory'|'file'}>{
 if(!options||Object.keys(options).some(k=>!['dataPath','directories','files'].includes(k))||!validPath(options.dataPath)||!options.directories||Object.keys(options.directories).length!==4||Object.keys(options.directories).some(k=>!directoryNames.includes(k as typeof directoryNames[number]))||options.files&&Object.keys(options.files).some(k=>!fileNames.includes(k as typeof fileNames[number])))throw new TypeError('Invalid trusted legacy path declaration');
 const entries=[...directoryNames.map(relative=>({relative,physical:options.directories[relative],kind:'directory' as const})),...fileNames.filter(relative=>options.files?.[relative]!==undefined).map(relative=>({relative,physical:options.files![relative]!,kind:'file' as const}))];
 if(entries.some(e=>!validPath(e.physical)))throw new TypeError('Legacy paths require approved canonical physical names');return entries;
}
export function validateLegacyProductPaths(options:LegacyProductPaths):void{declaration(options);}
async function physical(path:string,kind:'directory'|'file'){
 if(await realpath(path)!==path)throw new Error('Legacy source physical path changed');const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|(kind==='directory'?constants.O_DIRECTORY:0));
 try{const info=await fd.stat({bigint:true});if(kind==='directory'?!info.isDirectory():!info.isFile()||info.nlink!==1n)throw new Error('Legacy source type rejected');if(info.uid!==BigInt(process.getuid!())&&info.uid!==0n||(Number(info.mode)&0o022)!==0)throw new Error('Legacy source ownership or write permissions rejected');return {dev:info.dev.toString(),ino:info.ino.toString()};}finally{await fd.close();}
}
async function receipt(root:FileHandle):Promise<Receipt|undefined>{
 let fd;try{fd=await open('/proc/self/fd/'+root.fd+'/.node-layout-paths.json',constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
 try{const s=await fd.stat();if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid!()||(s.mode&0o077)!==0)throw new Error('Invalid path receipt owner');const bytes=Buffer.alloc(65537);let at=0;while(at<bytes.length){const r=await fd.read(bytes,at,bytes.length-at,null);if(!r.bytesRead)break;at+=r.bytesRead;}if(at>65536)throw new Error('Path receipt exceeds capacity');const parsed:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,at)));if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('Invalid path receipt');const row=parsed as Record<string,unknown>;if(Object.keys(row).length!==8||Object.keys(row).some(k=>!['schema','phase','dataPath','rootDev','rootIno','certsDev','certsIno','bindings'].includes(k))||row.schema!==1||row.phase!=='preparing'&&row.phase!=='published'||!validPath(row.dataPath)||typeof row.rootDev!=='string'||!/^[0-9]+$/u.test(row.rootDev)||typeof row.rootIno!=='string'||!/^[0-9]+$/u.test(row.rootIno)||(row.certsDev===null)!==(row.certsIno===null)||row.certsDev!==null&&(typeof row.certsDev!=='string'||!/^[0-9]+$/u.test(row.certsDev)||typeof row.certsIno!=='string'||!/^[0-9]+$/u.test(row.certsIno))||!Array.isArray(row.bindings)||row.bindings.length<4||row.bindings.length>7)throw new Error('Invalid path receipt schema');for(const b of row.bindings){if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).length!==5||Object.keys(b).some(k=>!['relative','physical','kind','dev','ino'].includes(k))||typeof b.relative!=='string'||!validPath(b.physical)||b.kind!=='directory'&&b.kind!=='file'||typeof b.dev!=='string'||!/^[0-9]+$/u.test(b.dev)||typeof b.ino!=='string'||!/^[0-9]+$/u.test(b.ino))throw new Error('Invalid path binding');}return row as unknown as Receipt;}finally{await fd.close();}
}
/** One pre-open owner, before file/config/database owners acquire paths. Only
 * administrator-declared standard names may be aliased. Physical paths are
 * returned for NOFOLLOW consumers; HTTP never grants an alias capability. */
export class LegacyProductPathOwner {
 readonly #options:LegacyProductPaths;readonly #root:FileHandle;readonly #bindings:readonly Binding[];readonly #certs:FileHandle|undefined;#closed=false;
 private constructor(options:LegacyProductPaths,root:FileHandle,bindings:Binding[],certs:FileHandle|undefined){this.#options=options;this.#root=root;this.#certs=certs;this.#bindings=Object.freeze(bindings.map(b=>Object.freeze({...b})));}
 static async open(incoming:LegacyProductPaths,signal:AbortSignal):Promise<LegacyProductPathOwner>{
  const options=structuredClone(incoming),entries=declaration(options);signal.throwIfAborted();
  try{await mkdir(options.dataPath,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  if(await realpath(options.dataPath)!==options.dataPath)throw new Error('Legacy data directory cannot itself be aliased');const root=await open(options.dataPath,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  let certs:FileHandle|undefined;
  try{
   const info=await root.stat();if(info.uid!==process.getuid!()||(info.mode&0o022)!==0)throw new Error('Legacy data root requires service ownership and no public writes');native.lockDirectory(root.fd);
   const before=await receipt(root),bindings:Binding[]=[];
   // Only missing standard directories inside this approved root are created.
   // An external legacy source is never synthesized or replaced.
   for(const entry of entries){signal.throwIfAborted();if(!before&&entry.kind==='directory'&&entry.physical===join(options.dataPath,entry.relative)){try{await mkdir('/proc/self/fd/'+root.fd+'/'+entry.relative,{mode:0o700});await root.sync();}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}}const identity=await physical(entry.physical,entry.kind);bindings.push({...entry,...identity});}
   let certsIdentity:{dev:string;ino:string}|undefined;
   if(entries.some(e=>e.relative.startsWith('certs/'))){const certsPath='/proc/self/fd/'+root.fd+'/certs';if(!before)try{await mkdir(certsPath,{mode:0o700});await root.sync();}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}certs=await open(certsPath,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);const held=await certs.stat(),visible=await lstat(certsPath);if(!visible.isDirectory()||visible.isSymbolicLink()||held.uid!==process.getuid!()||(held.mode&0o022)!==0||held.dev!==visible.dev||held.ino!==visible.ino)throw new Error('Unsafe certificate alias directory');certsIdentity={dev:String(held.dev),ino:String(held.ino)};}

   if(before&&(before.dataPath!==options.dataPath||before.rootDev!==String(info.dev)||before.rootIno!==String(info.ino)||before.certsDev!==(certsIdentity?.dev??null)||before.certsIno!==(certsIdentity?.ino??null)||JSON.stringify(before.bindings)!==JSON.stringify(bindings)))throw new Error('Approved legacy path mapping changed');
   const save=async(phase:Receipt['phase'],initial=false)=>{const name='.node-layout-paths.json',tmp=initial?name:name+'.tmp-'+randomUUID(),fd=await open('/proc/self/fd/'+root.fd+'/'+tmp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await fd.writeFile(JSON.stringify({schema:1,phase,dataPath:options.dataPath,rootDev:String(info.dev),rootIno:String(info.ino),certsDev:certsIdentity?.dev??null,certsIno:certsIdentity?.ino??null,bindings})+'\n');await fd.sync();}finally{await fd.close();}if(!initial)await rename('/proc/self/fd/'+root.fd+'/'+tmp,'/proc/self/fd/'+root.fd+'/'+name);await root.sync();};
   if(!before)await save('preparing',true);
   for(const binding of bindings){signal.throwIfAborted();const logical=join(options.dataPath,binding.relative);let path='/proc/self/fd/'+root.fd+'/'+binding.relative,parent:FileHandle|undefined;
    if(binding.physical===logical)continue;
    try{
    if(binding.relative.startsWith('certs/')){parent=certs!;path='/proc/self/fd/'+parent.fd+'/'+basename(binding.relative);}
    let current;try{current=await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(current?.isSymbolicLink()){if(current.uid!==process.getuid!()||resolve(dirname(logical),await readlink(path))!==binding.physical)throw new Error('Existing legacy alias conflict');await (parent??root).sync();continue;}
    if(before?.phase==='published'&&!current)throw new Error('Published legacy alias missing');
    if(current){if(before?.phase==='published'||binding.kind!=='directory'||!current.isDirectory()||current.uid!==process.getuid!()||(await readdir(path)).length)throw new Error('Nonempty or unexpected legacy destination conflict');const again=await lstat(path);if(again.dev!==current.dev||again.ino!==current.ino)throw new Error('Legacy destination changed');await rmdir(path);}
    await symlink(binding.physical,path);await (parent??root).sync();
    }finally{/* The shared certs descriptor remains process-owned. */}
   }
   const owner=new LegacyProductPathOwner(options,root,bindings,certs);await owner.verify(signal);if(before?.phase!=='published')await save('published');return owner;
  }catch(error){try{await certs?.close();}finally{await root.close();}throw error;}
 }
 physical(relative:string):string{if(this.#closed)throw new Error('Legacy path owner closed');const binding=this.#bindings.find(b=>b.relative===relative);if(!binding)throw new Error('Unapproved legacy path');return binding.physical;}
 get mapping(){return this.#bindings.map(b=>({...b}));}
 async verify(signal:AbortSignal):Promise<void>{
  if(this.#closed)throw new Error('Legacy path owner closed');signal.throwIfAborted();const current=await lstat(this.#options.dataPath),root=await this.#root.stat();if(!current.isDirectory()||current.isSymbolicLink()||current.dev!==root.dev||current.ino!==root.ino)throw new Error('Legacy data root replaced');
  if(this.#certs){const visible=await lstat('/proc/self/fd/'+this.#root.fd+'/certs'),held=await this.#certs.stat();if(!visible.isDirectory()||visible.isSymbolicLink()||visible.dev!==held.dev||visible.ino!==held.ino)throw new Error('Certificate alias parent replaced');}
  for(const b of this.#bindings){signal.throwIfAborted();const identity=await physical(b.physical,b.kind);if(identity.dev!==b.dev||identity.ino!==b.ino)throw new Error('Legacy source inode replaced');const logical=join(this.#options.dataPath,b.relative),path=b.relative.startsWith('certs/')?'/proc/self/fd/'+this.#certs!.fd+'/'+basename(b.relative):'/proc/self/fd/'+this.#root.fd+'/'+b.relative;if(logical!==b.physical){const alias=await lstat(path);if(!alias.isSymbolicLink()||alias.uid!==process.getuid!()||resolve(dirname(logical),await readlink(path))!==b.physical)throw new Error('Legacy alias replaced');}}
 }
 async close():Promise<void>{if(!this.#closed){this.#closed=true;try{await this.#certs?.close();}finally{await this.#root.close();}}}
}
