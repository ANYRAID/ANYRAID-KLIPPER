/** Visible POSIX namespace only. Paths never become blob/receipt filesystem
 * paths; the private store opens content exclusively by validated identifiers. */
export function publishedPath(value:unknown,root=false):string{
 if(typeof value!=='string'||!value.isWellFormed()||(!value&&!root)||Buffer.byteLength(value)>1024||/[\\\0-\x1f\x7f]/u.test(value)||value.startsWith('/')||value.endsWith('/')&&value!=='')throw new TypeError('Invalid published path');
 if(!value)return '';
 const parts=value.split('/');if(parts.length>32||parts.some(p=>!p||p==='.'||p==='..'||p==='.thumbs'||p==='.git'||Buffer.byteLength(p)>255))throw new TypeError('Invalid published path');return value;
}
export const visibleFilePath=(file:{id:string;path?:string})=>file.path??file.id+'.gcode';
export const pathParent=(path:string)=>path.includes('/')?path.slice(0,path.lastIndexOf('/')):'';
export const pathBasename=(path:string)=>path.slice(path.lastIndexOf('/')+1);
export function gcodesDirectory(value:unknown='gcodes'):string{
 if(typeof value!=='string')throw new TypeError('Invalid gcodes directory');
 const path=value.replace(/^\//u,'').replace(/\/$/u,'');if(path==='gcodes')return '';if(!path.startsWith('gcodes/'))throw new TypeError('Invalid gcodes root');return publishedPath(path.slice(7));
}
export class PublishedDirectoryCommitError extends Error {
 readonly phase:'before-replace'|'replaced';
 constructor(phase:'before-replace'|'replaced',cause:unknown){super('Directory transaction requires recovery',{cause});this.phase=phase;}
}
