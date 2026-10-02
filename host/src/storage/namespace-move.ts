import {publishedPath,visibleFilePath,pathParent,pathBasename} from './published-paths.ts';
import type {PublishedPrintFile} from './published-files.ts';
export interface MoveEntry {readonly before:PublishedPrintFile;readonly after:PublishedPrintFile;readonly modified:number;}
export interface NamespaceMove {
 readonly version:1;readonly action:'move_dir';readonly source:string;readonly destination:string;
 readonly changed:readonly MoveEntry[];
 readonly directoriesBefore:readonly {path:string;modified:number}[];
 readonly directoriesAfter:readonly {path:string;modified:number}[];
}
export const samePublishedFile=(a:PublishedPrintFile,b:PublishedPrintFile)=>a.id===b.id&&a.sha256===b.sha256&&a.size===b.size&&a.name===b.name&&visibleFilePath(a)===visibleFilePath(b);
const error=(message:string,code:string)=>Object.assign(new Error(message),{code});
const movedPath=(value:string)=>{try{return publishedPath(value);}catch(cause){throw Object.assign(new TypeError('Invalid resolved move path',{cause}),{code:'EINVAL'});}};
const catalog=(directories:ReadonlyMap<string,number>)=>[...directories].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([path,modified])=>Object.freeze({path,modified}));
const sameDirectories=(a:NamespaceMove['directoriesBefore'],b:NamespaceMove['directoriesBefore'])=>a.length===b.length&&a.every((e,i)=>e.path===b[i].path&&e.modified===b[i].modified);
export function sameNamespaceMove(a:NamespaceMove,b:NamespaceMove):boolean{return a.source===b.source&&a.destination===b.destination&&a.changed.length===b.changed.length&&a.changed.every((e,i)=>samePublishedFile(e.before,b.changed[i].before)&&samePublishedFile(e.after,b.changed[i].after)&&e.modified===b.changed[i].modified)&&sameDirectories(a.directoriesBefore,b.directoriesBefore)&&sameDirectories(a.directoriesAfter,b.directoriesAfter);}
/** Directory operations retain immutable content/print IDs. File overwrite and
 * copy remain separate contracts; an intent cannot smuggle those operations. */
export function planNamespaceMove(source:string,destination:string,records:readonly {file:PublishedPrintFile;modified:number}[],directories:ReadonlyMap<string,number>):NamespaceMove{
 publishedPath(source);publishedPath(destination,true);
 if(!directories.has(source))throw error('Move directory not found','ENOENT');
 const target=movedPath(!destination||directories.has(destination)?(destination?destination+'/':'')+pathBasename(source):destination);
 if(target===source||target.startsWith(source+'/'))throw error('Cannot move a directory into itself','EINVAL');
 if(pathParent(target)&&!directories.has(pathParent(target)))throw error('Move destination parent not found','ENOENT');
 if(directories.has(target)||records.some(e=>visibleFilePath(e.file)===target))throw error('Move destination exists','EEXIST');
 validateNamespace(records.map(e=>e.file),catalog(directories));
 const next=new Map(directories),changed:MoveEntry[]=[];
 for(const [path,modified] of directories)if(path===source||path.startsWith(source+'/')){next.delete(path);next.set(movedPath(target+path.slice(source.length)),modified);}
 for(const {file,modified} of records)if(visibleFilePath(file).startsWith(source+'/')){const path=movedPath(target+visibleFilePath(file).slice(source.length));changed.push(Object.freeze({before:file,after:Object.freeze({...file,path,name:pathBasename(path)}),modified}));}
 changed.sort((a,b)=>a.before.id<b.before.id?-1:a.before.id>b.before.id?1:0);
 const moved=new Map(changed.map(e=>[e.before.id,e.after])),after=catalog(next);
 validateNamespace(records.map(e=>moved.get(e.file.id)??e.file),after);
 return Object.freeze({version:1,action:'move_dir',source,destination:target,changed:Object.freeze(changed),directoriesBefore:Object.freeze(catalog(directories)),directoriesAfter:Object.freeze(after)});
}
export function validateNamespace(files:readonly PublishedPrintFile[],directories:NamespaceMove['directoriesBefore']):void{
 if(files.length>10000||directories.length>1024)throw new Error('Move namespace limit exceeded');
 const dirs=new Set<string>(),paths=new Set<string>(),ids=new Set<string>();
 for(const entry of directories){publishedPath(entry.path);if(dirs.has(entry.path)||!Number.isFinite(entry.modified)||entry.modified<0)throw new Error('Invalid move directory catalog');dirs.add(entry.path);}
 for(const path of dirs)if(pathParent(path)&&!dirs.has(pathParent(path)))throw new Error('Move directory parent missing');
 for(const file of files){const path=publishedPath(visibleFilePath(file));if(ids.has(file.id)||paths.has(path)||dirs.has(path)||pathParent(path)&&!dirs.has(pathParent(path)))throw new Error('Invalid move file namespace');ids.add(file.id);paths.add(path);}
}
const object=(value:unknown,keys:readonly string[]):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key));
function receipt(value:unknown):PublishedPrintFile{
 if(!object(value,['version','id','sha256','size','name','path'])||value.version!==1||typeof value.id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(value.id)||typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256)||!Number.isSafeInteger(value.size)||(value.size as number)<0||(value.size as number)>1024**3||typeof value.name!=='string'||!value.name||value.name.length>256||/[\0-\x1f\x7f]/u.test(value.name))throw new Error('Invalid move receipt');
 if(value.path!==undefined)publishedPath(value.path);return Object.freeze({...value}) as unknown as PublishedPrintFile;
}
/** Validate exact schema and deterministic path transformation independently of
 * JSON key order. Recovery also replans using ALL current records. */
export function validateMoveIntent(value:unknown):NamespaceMove{
 if(!object(value,['version','action','source','destination','changed','directoriesBefore','directoriesAfter'])||value.version!==1||value.action!=='move_dir'||!Array.isArray(value.changed)||value.changed.length>10000||!Array.isArray(value.directoriesBefore)||!Array.isArray(value.directoriesAfter)||value.directoriesBefore.length>1024||value.directoriesAfter.length>1024)throw new Error('Invalid move intent schema');
 const changed=value.changed.map(entry=>{if(!object(entry,['before','after','modified'])||typeof entry.modified!=='number'||!Number.isFinite(entry.modified)||entry.modified<0)throw new Error('Invalid move entry');const before=receipt(entry.before),after=receipt(entry.after);if(before.id!==after.id||before.sha256!==after.sha256||before.size!==after.size)throw new Error('Invalid move identity');return Object.freeze({before,after,modified:entry.modified});});
 const dirs=(entries:unknown[])=>entries.map(entry=>{if(!object(entry,['path','modified'])||typeof entry.modified!=='number')throw new Error('Invalid move directory entry');return Object.freeze({path:publishedPath(entry.path),modified:entry.modified});});
 const plan:NamespaceMove=Object.freeze({version:1,action:'move_dir',source:publishedPath(value.source),destination:publishedPath(value.destination),changed:Object.freeze(changed),directoriesBefore:Object.freeze(dirs(value.directoriesBefore)),directoriesAfter:Object.freeze(dirs(value.directoriesAfter))});
 const expected=planNamespaceMove(plan.source,plan.destination,changed.map(e=>({file:e.before,modified:e.modified})),new Map(plan.directoriesBefore.map(e=>[e.path,e.modified])));
 if(!sameNamespaceMove(expected,plan))throw new Error('Move intent differs from its operation');return plan;
}
export function recoverMoveRecords(plan:NamespaceMove,files:readonly PublishedPrintFile[],directories:ReadonlyMap<string,number>):PublishedPrintFile[]{
 const existing=new Map(files.map(f=>[f.id,f])),changed=new Map(plan.changed.map(e=>[e.before.id,e]));
 if(existing.size!==files.length||changed.size!==plan.changed.length)throw new Error('Duplicate move identity');
 for(const entry of plan.changed){const current=existing.get(entry.before.id);if(!current||!samePublishedFile(current,entry.before)&&!samePublishedFile(current,entry.after))throw new Error('Move recovery source changed outside transaction');}
 const current=catalog(directories);if(!sameDirectories(current,plan.directoriesBefore)&&!sameDirectories(current,plan.directoriesAfter))throw new Error('Move recovery directory catalog changed');
 const before=files.map(file=>({file:changed.get(file.id)?.before??file,modified:changed.get(file.id)?.modified??0}));
 const expected=planNamespaceMove(plan.source,plan.destination,before,new Map(plan.directoriesBefore.map(e=>[e.path,e.modified])));
 // Detect an omitted/new source child or an unapproved collision before touching
 // any receipt, directory index, temporary file or orphan blob.
 if(!sameNamespaceMove(expected,plan))throw new Error('Move recovery membership changed');
 const result=files.map(f=>changed.get(f.id)?.after??f);validateNamespace(result,plan.directoriesAfter);return result;
}
