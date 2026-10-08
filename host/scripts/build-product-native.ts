import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile,readdir,rm,copyFile,lstat} from 'node:fs/promises';
import {dirname,join,resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
export const productAddons=['trapq','stepcompress','serialqueue','unix-peer','sealed-file','file-events','can-query','ar100-flash'] as const;
export const productExecutables=['fatfs-helper','file-write-lease'] as const;
const scripts=['build-fatfs.ts','build-file-write-lease.ts','build-native.ts',...productAddons.slice(1).map(name=>'build-'+name+'.ts')];
/** Compile a private snapshot of the required C sources. No existing addon or
 * Python file is copied; callers publish the result only after the whole build. */
export async function buildProductNative(destination:string):Promise<void>{
 const target=resolve(destination);await mkdir(target);const scratch=await mkdtemp(join(dirname(target),'.native-source-'));
 try{
  const sources:Record<string,string>={},digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
  const capture=async(path:string)=>{const source=join(root,path),info=await lstat(source);if(!info.isFile()||info.isSymbolicLink())throw new Error('Invalid native source: '+path);const bytes=await readFile(source),to=join(scratch,path);await mkdir(dirname(to),{recursive:true});await writeFile(to,bytes);sources[path]=digest(bytes);};
  for(const directory of ['host/native','klippy/chelper','lib/fatfs'])for(const name of (await readdir(join(root,directory))).sort())if(/\.(?:c|h|inc)$/.test(name))await capture(directory+'/'+name);
  await capture('lib/fatfs/LICENSE.txt');await capture('src/compiler.h');for(const name of scripts)await capture('host/scripts/'+name);
  await writeFile(join(scratch,'package.json'),' {"type":"module"}\n');
  const include=resolve(process.env.NODE_INCLUDE??join(dirname(process.execPath),'../include/node'));
  // Snapshot all Node headers too, so compilation and recorded hashes describe
  // the same bytes. System compiler/libc headers remain platform prerequisites.
  const headers:Record<string,string>={};
  const captureHeaders=async(path:string):Promise<void>=>{for(const entry of (await readdir(path,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const source=join(path,entry.name),name=relative(include,source);if(entry.isDirectory())await captureHeaders(source);else if(entry.isFile()){const bytes=await readFile(source),to=join(scratch,'node-headers',name);await mkdir(dirname(to),{recursive:true});await writeFile(to,bytes);headers[name]=digest(bytes);}else throw new Error('Node headers must be ordinary files');}};
  await captureHeaders(include);
  const compiler=process.env.CC??'cc',version=spawnSync(compiler,['--version'],{encoding:'utf8',timeout:10000,maxBuffer:65536});if(version.error||version.status!==0)throw new Error('Native compiler unavailable');
  for(const script of scripts){const result=spawnSync(process.execPath,[join(scratch,'host/scripts',script)],{env:{...process.env,NODE_INCLUDE:join(scratch,'node-headers'),NODE_PATH:'',NODE_OPTIONS:''},encoding:'utf8',timeout:60000,maxBuffer:1024**2});if(result.error||result.status!==0)throw new Error('Fresh native build failed: '+script+'\n'+(result.error?.message??result.stdout+result.stderr));}
  const outputs:Record<string,string>={};for(const name of [...productAddons.map(addon=>addon+'.node'),...productExecutables]){const source=join(scratch,'host/build',name);outputs[name]=digest(await readFile(source));await copyFile(source,join(target,name));}
  await writeFile(join(target,'native-build-info.json'),JSON.stringify({schema:1,node:process.version,platform:process.platform,arch:process.arch,compiler:version.stdout.trim().split('\n')[0],sources,nodeHeaders:headers,outputs,scope:'Private source and Node header snapshots; compiler, system headers and libraries are supplied by the build machine. Not a signed or hermetic toolchain attestation.'},null,2)+'\n');
 }catch(error){await rm(target,{recursive:true,force:true});throw error;}finally{await rm(scratch,{recursive:true,force:true});}
}
