import {publishedPath,visibleFilePath} from './published-paths.ts';
import {samePublishedFile,validateNamespace} from './namespace-move.ts';
import {replacementNamespaceHash} from './namespace-replace.ts';
import type {PublishedPrintFile} from './published-files.ts';
import {validatePublishedReceipt} from './published-receipt.ts';
export interface NamespaceDelete {
 readonly version:1;readonly action:'delete_dir';readonly source:string;readonly namespaceSha256:string;
 readonly deleted:readonly {file:PublishedPrintFile;modified:number}[];
 readonly directoriesBefore:readonly {path:string;modified:number}[];
 readonly directoriesAfter:readonly {path:string;modified:number}[];
}
const child=(path:string,root:string)=>path===root||path.startsWith(root+'/');
const catalog=(dirs:ReadonlyMap<string,number>)=>[...dirs].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([path,modified])=>Object.freeze({path,modified}));
const sameDirs=(a:NamespaceDelete['directoriesBefore'],b:NamespaceDelete['directoriesBefore'])=>a.length===b.length&&a.every((e,i)=>e.path===b[i].path&&e.modified===b[i].modified);
export const sameNamespaceDelete=(a:NamespaceDelete,b:NamespaceDelete)=>a.source===b.source&&a.namespaceSha256===b.namespaceSha256&&sameDirs(a.directoriesBefore,b.directoriesBefore)&&sameDirs(a.directoriesAfter,b.directoriesAfter)&&a.deleted.length===b.deleted.length&&a.deleted.every((e,i)=>samePublishedFile(e.file,b.deleted[i].file)&&e.modified===b.deleted[i].modified);
/** Bind the complete namespace, including surviving references, before a
 * destructive decision. Visible paths never become private filesystem paths. */
export async function planNamespaceDelete(source:string,records:readonly {file:PublishedPrintFile;modified:number}[],directories:ReadonlyMap<string,number>):Promise<NamespaceDelete>{
 publishedPath(source);if(!directories.has(source))throw Object.assign(new Error('Delete directory not found'),{code:'ENOENT'});
 const before=catalog(directories);validateNamespace(records.map(e=>e.file),before);
 const deleted=records.filter(e=>child(visibleFilePath(e.file),source)).sort((a,b)=>a.file.id<b.file.id?-1:a.file.id>b.file.id?1:0).map(e=>Object.freeze({...e}));
 if(deleted.some(e=>!Number.isFinite(e.modified)||e.modified<0))throw new Error('Invalid delete modification time');
 const after=before.filter(e=>!child(e.path,source));validateNamespace(records.filter(e=>!child(visibleFilePath(e.file),source)).map(e=>e.file),after);
 return Object.freeze({version:1,action:'delete_dir',source,namespaceSha256:await replacementNamespaceHash(records.map(e=>e.file),before),deleted:Object.freeze(deleted),directoriesBefore:Object.freeze(before),directoriesAfter:Object.freeze(after)});
}
const object=(v:unknown,keys:readonly string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k));
function receipt(v:unknown):PublishedPrintFile{
 try{return validatePublishedReceipt(v);}catch(cause){throw new Error('Invalid delete receipt',{cause});}
}
export function validateDeleteIntent(v:unknown):NamespaceDelete{
 if(!object(v,['version','action','source','namespaceSha256','deleted','directoriesBefore','directoriesAfter'])||v.version!==1||v.action!=='delete_dir'||typeof v.namespaceSha256!=='string'||!/^[a-f0-9]{64}$/.test(v.namespaceSha256)||!Array.isArray(v.deleted)||v.deleted.length>10000||!Array.isArray(v.directoriesBefore)||v.directoriesBefore.length>1024||!Array.isArray(v.directoriesAfter)||v.directoriesAfter.length>1024)throw new Error('Invalid delete intent schema');
 const source=publishedPath(v.source),deleted=v.deleted.map(e=>{if(!object(e,['file','modified'])||typeof e.modified!=='number'||!Number.isFinite(e.modified)||e.modified<0)throw new Error('Invalid delete entry');const file=receipt(e.file);if(!child(visibleFilePath(file),source))throw new Error('Delete receipt outside authorized directory');return Object.freeze({file,modified:e.modified});});
 const dirs=(entries:unknown[])=>entries.map(e=>{if(!object(e,['path','modified'])||typeof e.modified!=='number'||!Number.isFinite(e.modified)||e.modified<0)throw new Error('Invalid delete directory');return Object.freeze({path:publishedPath(e.path),modified:e.modified});});
 const before=dirs(v.directoriesBefore),after=dirs(v.directoriesAfter);validateNamespace(deleted.map(e=>e.file),before);validateNamespace([],after);
 if(!before.some(e=>e.path===source)||!sameDirs(before,catalog(new Map(before.map(e=>[e.path,e.modified]))))||!sameDirs(after,before.filter(e=>!child(e.path,source)))||deleted.some((e,i)=>i>0&&deleted[i-1].file.id>=e.file.id))throw new Error('Delete intent differs from its operation');
 return Object.freeze({version:1,action:'delete_dir',source,namespaceSha256:v.namespaceSha256,deleted:Object.freeze(deleted),directoriesBefore:Object.freeze(before),directoriesAfter:Object.freeze(after)});
}
/** Missing target receipts are permitted after an interrupted decision, but
 * replacement identities, extra children or changed survivors are refused
 * before any deletion or garbage collection. */
export async function recoverDeleteRecords(plan:NamespaceDelete,files:readonly PublishedPrintFile[],directories:ReadonlyMap<string,number>):Promise<PublishedPrintFile[]>{
 const current=new Map(files.map(f=>[f.id,f]));if(current.size!==files.length)throw new Error('Duplicate delete recovery identity');
 const dirs=catalog(directories);if(!sameDirs(dirs,plan.directoriesBefore)&&!sameDirs(dirs,plan.directoriesAfter))throw new Error('Delete recovery directory catalog changed');
 for(const {file} of plan.deleted){const actual=current.get(file.id);if(actual&&!samePublishedFile(actual,file))throw new Error('Delete recovery identity changed');current.set(file.id,file);}
 if(await replacementNamespaceHash([...current.values()],plan.directoriesBefore)!==plan.namespaceSha256)throw new Error('Delete recovery namespace changed');
 const modified=new Map(plan.deleted.map(e=>[e.file.id,e.modified]));const expected=await planNamespaceDelete(plan.source,[...current.values()].map(file=>({file,modified:modified.get(file.id)??0})),new Map(plan.directoriesBefore.map(e=>[e.path,e.modified])));
 if(!sameNamespaceDelete(plan,expected))throw new Error('Delete recovery membership changed');
 const removed=new Set(plan.deleted.map(e=>e.file.id)),survivors=files.filter(f=>!removed.has(f.id));validateNamespace(survivors,plan.directoriesAfter);return survivors;
}
