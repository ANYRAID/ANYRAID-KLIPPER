import {publishedPath,visibleFilePath,pathParent,pathBasename} from './published-paths.ts';
import {samePublishedFile,validateNamespace} from './namespace-move.ts';
import type {PublishedPrintFile} from './published-files.ts';
export interface CopyEntry {readonly source:PublishedPrintFile;readonly created:PublishedPrintFile;readonly modified:number;}
export interface NamespaceCopy {
 readonly version:1;readonly action:'create_file'|'modify_file'|'create_dir';readonly source:string;readonly destination:string;readonly createdAt:number;
 readonly entries:readonly CopyEntry[];readonly replaced?:PublishedPrintFile;
 readonly directoriesBefore:readonly {path:string;modified:number}[];readonly directoriesAfter:readonly {path:string;modified:number}[];
}
const error=(message:string,code:string)=>Object.assign(new Error(message),{code});
const resolvedPath=(path:string)=>{try{return publishedPath(path);}catch(cause){throw Object.assign(error('Resolved copy path exceeds namespace bounds','EINVAL'),{cause});}};
const catalog=(dirs:ReadonlyMap<string,number>)=>Object.freeze([...dirs].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([path,modified])=>Object.freeze({path,modified})));
const sameDirs=(a:NamespaceCopy['directoriesBefore'],b:NamespaceCopy['directoriesBefore'])=>a.length===b.length&&a.every((e,i)=>e.path===b[i].path&&e.modified===b[i].modified);
export const sameNamespaceCopy=(a:NamespaceCopy,b:NamespaceCopy)=>a.action===b.action&&a.source===b.source&&a.destination===b.destination&&a.createdAt===b.createdAt&&!!a.replaced===!!b.replaced&&(!a.replaced||samePublishedFile(a.replaced,b.replaced!))&&a.entries.length===b.entries.length&&a.entries.every((e,i)=>samePublishedFile(e.source,b.entries[i].source)&&samePublishedFile(e.created,b.entries[i].created)&&e.modified===b.entries[i].modified)&&sameDirs(a.directoriesBefore,b.directoriesBefore)&&sameDirs(a.directoriesAfter,b.directoriesAfter);
/** copy2 replaces a file (including basename resolution in an existing directory).
 * copytree requires a new destination and creates missing ancestor directories.
 * Content hashes are retained; every copied receipt receives a fresh identity. */
export function planNamespaceCopy(source:string,destination:string,records:readonly {file:PublishedPrintFile;modified:number}[],directories:ReadonlyMap<string,number>,createId:(source:PublishedPrintFile)=>string,createdAt:number):NamespaceCopy{
 publishedPath(source);publishedPath(destination,true);if(!Number.isFinite(createdAt)||createdAt<0)throw new Error('Invalid copy timestamp');
 validateNamespace(records.map(e=>e.file),catalog(directories));
 const tree=directories.has(source),file=records.find(e=>visibleFilePath(e.file)===source);
 if(!tree&&!file)throw error('Copy source not found','ENOENT');
 const target=resolvedPath(tree?destination:(!destination||directories.has(destination)?(destination?destination+'/':'')+pathBasename(source):destination));
 if(target===source||tree&&target.startsWith(source+'/'))throw error('Cannot copy a path into itself','EINVAL');
 const replaced=records.find(e=>visibleFilePath(e.file)===target)?.file;
 if(tree&&(directories.has(target)||replaced))throw error('Copy directory destination exists','EEXIST');
 if(!tree&&pathParent(target)&&!directories.has(pathParent(target)))throw error('Copy destination parent not found','ENOENT');
 const next=new Map(directories),ids=new Set(records.map(e=>e.file.id)),paths=new Set(records.map(e=>visibleFilePath(e.file))),entries:CopyEntry[]=[];
 if(tree){
  let parent=pathParent(target);while(parent&&!next.has(parent)){if(paths.has(parent))throw error('Copy ancestor is a file','ENOTDIR');next.set(parent,createdAt);parent=pathParent(parent);}
  for(const [path,modified] of directories)if(path===source||path.startsWith(source+'/'))next.set(resolvedPath(target+path.slice(source.length)),modified);
 }
 const selected=(tree?records.filter(e=>visibleFilePath(e.file).startsWith(source+'/')):[file!]).sort((a,b)=>a.file.id<b.file.id?-1:a.file.id>b.file.id?1:0);
 for(const row of selected){
  const id=createId(row.file);if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(id)||ids.has(id))throw new Error('Copy identity collision');ids.add(id);
  if(!Number.isFinite(row.modified)||row.modified<0)throw new Error('Invalid copy source timestamp');
  const path=resolvedPath(tree?target+visibleFilePath(row.file).slice(source.length):target),sourceFile=Object.freeze({...row.file});
  entries.push(Object.freeze({source:sourceFile,created:Object.freeze({...sourceFile,id,path,name:pathBasename(path)}),modified:row.modified}));
 }
 const after=catalog(next);validateNamespace([...records.filter(e=>e.file.id!==replaced?.id).map(e=>e.file),...entries.map(e=>e.created)],after);
 return Object.freeze({version:1,action:tree?'create_dir':replaced?'modify_file':'create_file',source,destination:target,createdAt,entries:Object.freeze(entries),...replaced?{replaced:Object.freeze({...replaced})}:{},directoriesBefore:catalog(directories),directoriesAfter:after});
}
const object=(v:unknown,keys:readonly string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k));
function receipt(v:unknown):PublishedPrintFile{
 if(!object(v,['version','id','sha256','size','name','path'])||v.version!==1||typeof v.id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(v.id)||typeof v.sha256!=='string'||!/^[a-f0-9]{64}$/.test(v.sha256)||!Number.isSafeInteger(v.size)||(v.size as number)<0||(v.size as number)>1024**3||typeof v.name!=='string'||!v.name||v.name.length>256||/[\0-\x1f\x7f]/u.test(v.name))throw new Error('Invalid copy receipt');
 if(v.path!==undefined)publishedPath(v.path);return Object.freeze({...v}) as unknown as PublishedPrintFile;
}
export function validateCopyIntent(v:unknown):NamespaceCopy{
 if(!object(v,['version','action','source','destination','createdAt','entries','replaced','directoriesBefore','directoriesAfter'])||v.version!==1||!['create_file','modify_file','create_dir'].includes(v.action as string)||typeof v.createdAt!=='number'||!Array.isArray(v.entries)||v.entries.length>10000||!Array.isArray(v.directoriesBefore)||!Array.isArray(v.directoriesAfter)||v.directoriesBefore.length>1024||v.directoriesAfter.length>1024)throw new Error('Invalid copy intent schema');
 const entries=v.entries.map(e=>{if(!object(e,['source','created','modified'])||typeof e.modified!=='number')throw new Error('Invalid copy entry');const source=receipt(e.source),created=receipt(e.created);if(source.id===created.id||source.sha256!==created.sha256||source.size!==created.size)throw new Error('Invalid copy content identity');return Object.freeze({source,created,modified:e.modified});});
 const dirs=(values:unknown[])=>Object.freeze(values.map(e=>{if(!object(e,['path','modified'])||typeof e.modified!=='number')throw new Error('Invalid copy directory');return Object.freeze({path:publishedPath(e.path),modified:e.modified});}));
 const plan:NamespaceCopy=Object.freeze({version:1,action:v.action as NamespaceCopy['action'],source:publishedPath(v.source),destination:publishedPath(v.destination),createdAt:v.createdAt,entries:Object.freeze(entries),...v.replaced===undefined?{}:{replaced:receipt(v.replaced)},directoriesBefore:dirs(v.directoriesBefore),directoriesAfter:dirs(v.directoriesAfter)});
 const before=entries.map(e=>({file:e.source,modified:e.modified}));if(plan.replaced)before.push({file:plan.replaced,modified:0});
 const ids=new Map(entries.map(e=>[e.source.id,e.created.id]));const expected=planNamespaceCopy(plan.source,plan.destination,before,new Map(plan.directoriesBefore.map(e=>[e.path,e.modified])),f=>ids.get(f.id)!,plan.createdAt);
 if(!sameNamespaceCopy(expected,plan))throw new Error('Copy intent differs from operation');return plan;
}
/** Reconstruct the pre-operation namespace from any permitted partial prefix,
 * then replan using every record. Unexpected children/collisions fail closed. */
export function recoverCopyRecords(plan:NamespaceCopy,files:readonly PublishedPrintFile[],directories:ReadonlyMap<string,number>):PublishedPrintFile[]{
 const current=new Map(files.map(f=>[f.id,f])),created=new Set(plan.entries.map(e=>e.created.id));if(current.size!==files.length||created.size!==plan.entries.length)throw new Error('Duplicate copy identity');
 for(const e of plan.entries){if(!current.has(e.source.id)||!samePublishedFile(current.get(e.source.id)!,e.source))throw new Error('Copy recovery source changed');const added=current.get(e.created.id);if(added&&!samePublishedFile(added,e.created))throw new Error('Copy recovery destination changed');}
 if(plan.replaced&&current.has(plan.replaced.id)&&!samePublishedFile(current.get(plan.replaced.id)!,plan.replaced))throw new Error('Copy recovery replaced receipt changed');
 const dirs=catalog(directories);if(!sameDirs(dirs,plan.directoriesBefore)&&!sameDirs(dirs,plan.directoriesAfter))throw new Error('Copy recovery directory catalog changed');
 const before=files.filter(f=>!created.has(f.id));if(plan.replaced&&!current.has(plan.replaced.id))before.push(plan.replaced);
 const modified=new Map(plan.entries.map(e=>[e.source.id,e.modified])),ids=new Map(plan.entries.map(e=>[e.source.id,e.created.id]));
 const expected=planNamespaceCopy(plan.source,plan.destination,before.map(file=>({file,modified:modified.get(file.id)??0})),new Map(plan.directoriesBefore.map(e=>[e.path,e.modified])),f=>ids.get(f.id)!,plan.createdAt);
 if(!sameNamespaceCopy(expected,plan))throw new Error('Copy recovery membership changed');
 const after=[...before.filter(f=>f.id!==plan.replaced?.id),...plan.entries.map(e=>e.created)];validateNamespace(after,plan.directoriesAfter);return after;
}
