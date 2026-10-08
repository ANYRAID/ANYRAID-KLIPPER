import {createHash} from 'node:crypto';
import {publishedPath,visibleFilePath,pathBasename} from './published-paths.ts';
import {samePublishedFile,validateNamespace} from './namespace-move.ts';
import type {PublishedPrintFile} from './published-files.ts';
import {validatePublishedReceipt,samePublishedContent} from './published-receipt.ts';
export interface FileReplacement {
 readonly version:1;readonly action:'create_file'|'move_file';readonly created:PublishedPrintFile;readonly replaced:PublishedPrintFile;
 readonly source?:PublishedPrintFile;readonly modified:number;readonly namespaceSha256:string;
 readonly directories:readonly {path:string;modified:number}[];
}
export const replacementIntentLimit=2*1024**2;
const object=(v:unknown,keys:readonly string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k));
function receipt(v:unknown):PublishedPrintFile{
 try{return validatePublishedReceipt(v);}catch(cause){throw new Error('Invalid replacement receipt',{cause});}
}
/** Hash canonical identities incrementally; yield at bounded intervals so a
 * large catalog does not serialize into one synchronous journal-sized string. */
export async function replacementNamespaceHash(files:readonly PublishedPrintFile[],directories:readonly {path:string;modified:number}[]):Promise<string>{
 validateNamespace(files,directories);const hash=createHash('sha256');
 const ordered=[...files].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
 for(const [i,f] of ordered.entries()){hash.update(JSON.stringify([f.id,f.sha256,f.size,f.name,visibleFilePath(f),...f.preview?[f.preview.sha256,f.preview.size]:[]])+'\n');if(i%128===127)await new Promise<void>(resolve=>setImmediate(resolve));}
 hash.update(JSON.stringify([...directories].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)));return hash.digest('hex');
}
export function validateReplacementIntent(v:unknown):FileReplacement{
 if(!object(v,['version','action','created','replaced','source','modified','namespaceSha256','directories'])||v.version!==1||!['create_file','move_file'].includes(v.action as string)||typeof v.modified!=='number'||!Number.isFinite(v.modified)||v.modified<0||typeof v.namespaceSha256!=='string'||!/^[a-f0-9]{64}$/.test(v.namespaceSha256)||!Array.isArray(v.directories)||v.directories.length>1024)throw new Error('Invalid replacement intent schema');
 const created=receipt(v.created),replaced=receipt(v.replaced),source=v.source===undefined?undefined:receipt(v.source);
 if(created.id===replaced.id||visibleFilePath(created)!==visibleFilePath(replaced)||created.name!==pathBasename(visibleFilePath(created)))throw new Error('Invalid replacement destination identity');
 if(v.action==='create_file'&&source||v.action==='move_file'&&(!source||source.id!==created.id||!samePublishedContent(source,created)||visibleFilePath(source)===visibleFilePath(created)))throw new Error('Invalid replacement source identity');
 const directories=Object.freeze(v.directories.map(d=>{if(!object(d,['path','modified'])||typeof d.modified!=='number'||!Number.isFinite(d.modified)||d.modified<0)throw new Error('Invalid replacement directory');return Object.freeze({path:publishedPath(d.path),modified:d.modified});}));
 validateNamespace(source?[source,replaced]:[replaced],directories);validateNamespace([created],directories);
 if(directories.some((d,i)=>i>0&&directories[i-1].path>=d.path))throw new Error('Noncanonical replacement directory catalog');
 return Object.freeze({version:1,action:v.action as FileReplacement['action'],created,replaced,...source?{source}:{},modified:v.modified,namespaceSha256:v.namespaceSha256,directories});
}
/** Only the ordered durable prefixes are admissible: install/sync new receipt,
 * remove/sync retired receipt. Reconstruct the complete old namespace before
 * any repair or garbage collection, including unrelated record membership. */
export async function recoverReplacementRecords(plan:FileReplacement,files:readonly PublishedPrintFile[],directories:readonly {path:string;modified:number}[]):Promise<readonly PublishedPrintFile[]>{
 validateReplacementIntent(plan);
 if(JSON.stringify(directories)!==JSON.stringify(plan.directories))throw new Error('Replacement directory authority changed');
 const current=new Map(files.map(f=>[f.id,f]));if(current.size!==files.length)throw new Error('Duplicate replacement identity');
 const created=current.get(plan.created.id),replaced=current.get(plan.replaced.id);
 if(replaced&&!samePublishedFile(replaced,plan.replaced))throw new Error('Replacement retired identity changed');
 if(plan.source){if(!created||!samePublishedFile(created,plan.source)&&!samePublishedFile(created,plan.created))throw new Error('Replacement move source changed');}
 else if(created&&!samePublishedFile(created,plan.created))throw new Error('Replacement upload identity changed');
 if(!replaced&&(!created||!samePublishedFile(created,plan.created)))throw new Error('Replacement deletion precedes durable publication');
 const before=files.filter(f=>f.id!==plan.created.id&&f.id!==plan.replaced.id);
 before.push(plan.replaced);if(plan.source)before.push(plan.source);
 if(await replacementNamespaceHash(before,directories)!==plan.namespaceSha256)throw new Error('Replacement namespace membership changed');
 const after=[...before.filter(f=>f.id!==plan.replaced.id&&f.id!==plan.source?.id),plan.created];validateNamespace(after,directories);return Object.freeze(after);
}
