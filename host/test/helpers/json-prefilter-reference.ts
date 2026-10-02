import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
export async function oldJsonParser(){
 const source=execFileSync('git',['show','45cc48e6:host/src/moonraker/json.ts']);if(createHash('sha256').update(source).digest('hex')!=='4538829ef0c69aa57a11eab5c4f05bc3758c6eb4282bbbcc437c469cc9c6bb4d')throw new Error('JSON precision oracle hash mismatch');const dir=await mkdtemp(join(tmpdir(),'json-prefilter-')),path=join(dir,'reference.mts');try{await writeFile(path,source);const module=await import(pathToFileURL(path).href);return module.parseRequestJson as (text:string)=>unknown;}finally{await rm(dir,{recursive:true,force:true});}
}
