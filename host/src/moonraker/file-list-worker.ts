// Moonraker file_manager list/root semantics, GPL-3.0-or-later.
// Original Copyright (C) 2020 Eric Callahan. See pinned contracts manifest.
import {pythonLower} from './python-lower.ts';
import {parentPort,workerData} from 'node:worker_threads';
import {opendirSync,statSync,lstatSync,readlinkSync} from 'node:fs';
import {isAbsolute,join,dirname,extname} from 'node:path';
import type {FileListingOptions,FileRoot,FileListEntry} from './file-list.ts';
const options=workerData as Required<FileListingOptions>,port=parentPort!;
const error=(message:string,code=500)=>Object.assign(new Error(message),{code});
function canonical(path:string):string{
 let current='/',links=0;const parts=path.split('/');
 while(parts.length){const part=parts.shift()!;if(!part||part==='.')continue;if(part==='..'){current=dirname(current);continue;}const next=join(current,part);
  try{if(lstatSync(next).isSymbolicLink()){if(++links>40)throw error('Too many symbolic links');const target=readlinkSync(next);if(isAbsolute(target))current='/';parts.unshift(...target.split('/'));continue;}}
  catch(e){if(!['ENOENT','ENOTDIR'].includes((e as NodeJS.ErrnoException).code??''))throw e;}current=next;
 }return current;
}
function codepoints(a:string,b:string):number{const x=a[Symbol.iterator](),y=b[Symbol.iterator]();while(true){const p=x.next(),q=y.next();if(p.done||q.done)return p.done?(q.done?0:-1):1;const delta=p.value.codePointAt(0)!-q.value.codePointAt(0)!;if(delta)return delta;}}
const roots=new Map<string,FileRoot>(),reserved:{path:string;canRead:boolean}[]=[];
const contained=(base:string,path:string)=>path===base||path.startsWith(base==='/'?'/':base+'/');
function denied(path:string):boolean{return path.split('/').includes('.git')||reserved.some(item=>!item.canRead&&contained(item.path,path));}
function list(root:string,cancel:Int32Array):FileListEntry[]{
 const definition=roots.get(root);if(!definition)throw error(`Failed to build file list, invalid path: ${root}: None`,400);
 const check=()=>{if(Atomics.load(cancel,0))throw error('File listing cancelled',499);};
 check();let initial;try{initial=statSync(definition.path,{bigint:true});}catch(e){if(['ENOENT','ENOTDIR'].includes((e as NodeJS.ErrnoException).code??''))throw error(`Failed to build file list, invalid path: ${root}: ${definition.path}`,400);throw e;}if(!initial.isDirectory())throw error(`Failed to build file list, invalid path: ${root}: ${definition.path}`,400);
 const visited=new Set([`${initial.dev}:${initial.ino}`]),pending=[{path:definition.path,relative:''}],result:FileListEntry[]=[];
 let entries=0,outputBytes=2;
 while(pending.length){
  check();const directory=pending.pop()!,children:typeof pending=[];let handle;
  try{handle=opendirSync(directory.path,{encoding:'buffer' as BufferEncoding});}catch(e){if(directory.relative&&['ENOENT','EACCES','ENOTDIR'].includes((e as NodeJS.ErrnoException).code??''))continue;throw e;}
  try{for(let entry=handle.readSync();entry;entry=handle.readSync()){
   check();if(++entries>options.maxEntries)throw error('File listing entry limit exceeded',413);
   const name=Buffer.isBuffer(entry.name)?new TextDecoder('utf-8',{fatal:true}).decode(entry.name):entry.name;
   const full=join(directory.path,name),relative=directory.relative?directory.relative+'/'+name:name;
   if(Buffer.byteLength(relative)>4096)throw error('File listing path limit exceeded',413);
   let stat;try{stat=statSync(full,{bigint:true});}catch(e){if(['ENOENT','ENOTDIR','ELOOP'].includes((e as NodeJS.ErrnoException).code??''))continue;throw e;}
   if(stat.isDirectory()){
    const key=`${stat.dev}:${stat.ino}`;if(visited.has(key))continue;visited.add(key);
    if(!denied(canonical(full)))children.push({path:full,relative});continue;
   }
   if(root==='gcodes'&&!['.gcode','.g','.gco','.ufp','.nc'].includes(extname(name).toLowerCase()))continue;
   const real=canonical(full);let permissions:'rw'|'r'|''=definition.permissions;
   if(denied(real))permissions='';else if(entry.isSymbolicLink()&&stat.isFile()||reserved.some(item=>contained(item.path,real)))permissions='r';
   const size=Number(stat.size);if(!Number.isSafeInteger(size))throw error('File size exceeds exact JSON integer range');
   let seconds=stat.mtimeNs/1000000000n,nanos=stat.mtimeNs%1000000000n;if(nanos<0){seconds--;nanos+=1000000000n;}
   const value:FileListEntry={path:relative,modified:Number(seconds)+Number(nanos)*1e-9,size,permissions};
   outputBytes+=Buffer.byteLength(JSON.stringify(value))+1;
   if(result.length>=options.maxFiles||outputBytes>options.maxOutputBytes)throw error('File listing response limit exceeded',413);
   result.push(value);
  }}finally{handle.closeSync();}
  for(let i=children.length-1;i>=0;i--)pending.push(children[i]);
 }
 check();const keys=new Map<string,string>();for(const item of result){check();keys.set(item.path,pythonLower(item.path));}result.sort((a,b)=>codepoints(keys.get(a.path)!,keys.get(b.path)!));check();return result;
}
try{
 for(const definition of options.roots){const path=canonical(definition.path);if(path==='/'||!statSync(path).isDirectory())throw error('Invalid file root');const dir=opendirSync(path);dir.closeSync();roots.set(definition.name,{name:definition.name,path,permissions:definition.writable?'rw':'r'});}
 for(const item of options.reserved)reserved.push({path:canonical(item.path),canRead:item.canRead});
 port.postMessage({ready:true,roots:[...roots.values()]});
 port.on('message',({id,root,cancel}:{id:number;root:string;cancel:SharedArrayBuffer})=>{
  try{port.postMessage({id,value:list(root,new Int32Array(cancel))});}
  catch(e){port.postMessage({id,error:{code:typeof (e as any).code==='number'?(e as any).code:500,message:(e as Error).message}});}
 });
}catch(e){port.postMessage({ready:false,error:(e as Error).message});port.close();}
