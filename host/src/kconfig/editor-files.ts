import {readFile,writeFile,rename,unlink,realpath,lstat,readlink,stat} from 'node:fs/promises';
import {resolve,dirname,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {KconfigEditor} from './editor.ts';
import type {KTree} from './parser.ts';

interface Snapshot{destination:string;contents:string|null;mode?:number;}
async function destination(path:string,depth=0):Promise<string>{
 if(depth>=40)throw new Error('Configuration symlink depth limit');
 try{return await realpath(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 try{if((await lstat(path)).isSymbolicLink())return destination(resolve(dirname(path),await readlink(path)),depth+1);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 // Resolve existing parent symlinks even when the output itself is new.
 return resolve(await realpath(dirname(path)),basename(path));
}
async function snapshot(path:string):Promise<Snapshot>{
 const target=await destination(path);
 try{
  const info=await stat(target);if(!info.isFile()||info.size>8*1024*1024)throw new Error('Configuration must be a regular file of at most 8 MiB');
  const contents=new TextDecoder('utf-8',{fatal:true}).decode(await readFile(target));
  if(Buffer.byteLength(contents)>8*1024*1024)throw new Error('Configuration byte limit');
  return {destination:target,contents,mode:info.mode};
 }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {destination:target,contents:null};throw error;}
}
const same=(a:Snapshot,b:Snapshot)=>a.destination===b.destination&&a.contents===b.contents&&a.mode===b.mode;
async function atomic(path:string,contents:string,mode?:number):Promise<void>{
 const temporary=path+'.'+randomUUID()+'.tmp';
 try{await writeFile(temporary,contents,{flag:'wx',mode});await rename(temporary,path);}finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}

/** File transactions for the interactive editor. Conflicts are checked just
 * before replacement; this is optimistic detection, not a filesystem CAS. */
export class KconfigEditorFiles{
 editor:KconfigEditor;
 path:string;
 private saved:Snapshot;
 private readonly protectedFiles:Set<string>;
 private constructor(editor:KconfigEditor,path:string,saved:Snapshot,protectedFiles:Set<string>){
  this.editor=editor;this.path=path;this.saved=saved;this.protectedFiles=protectedFiles;
 }
 static async open(root:string,tree:KTree,path:string,prefix='CONFIG_',header=''):Promise<KconfigEditorFiles>{
  const absolute=resolve(path),saved=await snapshot(absolute);
  const protectedFiles=new Set(await Promise.all(tree.files.map(file=>realpath(resolve(root,file)))));
  if(protectedFiles.has(saved.destination))throw new Error('Configuration path overlaps a Kconfig source');
  return new KconfigEditorFiles(new KconfigEditor(tree,saved.contents??'',prefix,header),absolute,saved,protectedFiles);
 }
 async load(path:string,discard=false):Promise<void>{
  if(this.editor.dirty&&!discard)throw new Error('Unsaved changes: confirm discard before loading');
  const absolute=resolve(path),saved=await snapshot(absolute);
  if(saved.contents===null)throw new Error('Configuration file does not exist');
  if(this.protectedFiles.has(saved.destination))throw new Error('Configuration path overlaps a Kconfig source');
  const editor=new KconfigEditor(this.editor.tree,saved.contents,this.editor.prefix,this.editor.header);
  this.editor=editor;this.path=absolute;this.saved=saved;
 }
 private async write(path:string,contents:string,expected:Snapshot,backup:boolean):Promise<Snapshot>{
  if(this.protectedFiles.has(expected.destination))throw new Error('Output overlaps a Kconfig source');
  if(!same(await snapshot(path),expected))throw new Error('Configuration changed externally; reload or save to another path');
  if(expected.contents===contents)return expected;
  // A private lock serializes cooperating editor saves without stale retries.
  const lock=expected.destination+'.kconfig-lock';
  await writeFile(lock,'Kconfig editor save\n',{flag:'wx'});
  try{
   if(!same(await snapshot(path),expected))throw new Error('Configuration changed externally; reload or save to another path');
   if(backup&&expected.contents!==null){
    const backupTarget=await destination(path+'.old');
    if(backupTarget===expected.destination||this.protectedFiles.has(backupTarget))throw new Error('Backup overlaps configuration or Kconfig source');
    await atomic(path+'.old',expected.contents,expected.mode);
   }
   // Re-check after backup IO; external tools need not honor our lock.
   if(!same(await snapshot(path),expected))throw new Error('Configuration changed externally during save');
   await atomic(expected.destination,contents,expected.mode);
   const saved=await snapshot(path);
   if(saved.destination!==expected.destination||saved.contents!==contents)throw new Error('Configuration changed externally after replacement');
   return saved;
  }finally{await unlink(lock);}
 }
 async save(path=this.path,overwrite=false):Promise<void>{
  const absolute=resolve(path),isCurrent=absolute===this.path;
  const expected=isCurrent?this.saved:await snapshot(absolute);
  if(!isCurrent&&expected.contents!==null&&!overwrite)throw new Error('Destination exists: confirm overwrite');
  const editor=this.editor,contents=editor.full();
  const saved=await this.write(absolute,contents,expected,true);
  if(this.editor!==editor)throw new Error('Editor changed during save');
  this.editor.recordSavedSnapshot(contents);this.path=absolute;this.saved=saved;
 }
 async exportMinimal(path:string,overwrite=false):Promise<void>{
  const absolute=resolve(path),expected=await snapshot(absolute);
  if(absolute===this.path||expected.destination===this.saved.destination)throw new Error('Minimal export must not replace the active configuration');
  if(expected.contents!==null&&!overwrite)throw new Error('Destination exists: confirm overwrite');
  await this.write(absolute,this.editor.minimal(),expected,true);
 }
}
