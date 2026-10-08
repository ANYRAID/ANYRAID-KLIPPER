import {publishedPath} from './published-paths.ts';
import type {PublishedPrintFile,PublishedPreview} from './published-files.ts';
const object=(value:unknown,keys:readonly string[]):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key));
export function validatePreview(value:unknown):PublishedPreview{
 if(!object(value,['sha256','size'])||typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256)||!Number.isSafeInteger(value.size)||(value.size as number)<1||(value.size as number)>4*1024**2)throw new Error('Invalid published preview reference');
 return Object.freeze({sha256:value.sha256,size:value.size as number});
}
/** One receipt authority shared by ordinary reads and all namespace journals. */
export function validatePublishedReceipt(value:unknown,maxBytes=1024**3):PublishedPrintFile{
 if(!object(value,['version','id','sha256','size','name','path','preview'])||value.version!==1||typeof value.id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(value.id)||typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256)||!Number.isSafeInteger(value.size)||(value.size as number)<0||(value.size as number)>maxBytes||typeof value.name!=='string'||!value.name||value.name.length>256||/[\0-\x1f\x7f]/u.test(value.name))throw new Error('Invalid published file receipt');
 if(value.path!==undefined)publishedPath(value.path);
 return Object.freeze({version:1,id:value.id,sha256:value.sha256,size:value.size as number,name:value.name,...value.path===undefined?{}:{path:value.path as string},...value.preview===undefined?{}:{preview:validatePreview(value.preview)}});
}
export const samePublishedContent=(a:PublishedPrintFile,b:PublishedPrintFile)=>a.sha256===b.sha256&&a.size===b.size&&a.preview?.sha256===b.preview?.sha256&&a.preview?.size===b.preview?.size;
export const publishedContentIdentity=(file:PublishedPrintFile)=>JSON.stringify([file.sha256,file.size,file.preview?.sha256,file.preview?.size]);
