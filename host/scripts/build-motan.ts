import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cp,copyFile,mkdir,mkdtemp,readFile,writeFile,readdir,rename,rm,access,lstat} from 'node:fs/promises';
import {dirname,join,resolve,relative} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const host=fileURLToPath(new URL('..',import.meta.url));
/** Build separately, then publish only a complete type-checked distribution.
 * Rebuild while no exports use this destination. The output is generated data. */
export async function buildMotan(output=join(host,'build/motan'),config=join(host,'tsconfig.motan.json')):Promise<void>{
 const [major,minor]=process.versions.node.split('.').map(Number);
 if(major!==26||minor<9)throw new Error('Motan build requires Node.js 26.9 or later 26.x');
 const target=resolve(output),parent=dirname(target),lock=target+'.lock';
 await mkdir(parent,{recursive:true});
 try{await mkdir(lock);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error('Motan build destination is locked: '+lock);throw error;}
 let stage:string|undefined,backup:string|undefined,oldMoved=false,published=false;
 try{
  let present=false;try{const info=await lstat(target);present=true;if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Motan output must be a generated build directory');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(present){let marker;try{marker=JSON.parse(await readFile(join(target,'build-info.json'),'utf8'));}catch{throw new Error('Refusing to replace an unrecognized Motan output directory');}if(marker?.schema!==1||!marker.files?.['scripts/motan/data_export.js']||!marker.files?.['host/src/motan/analysis-worker.js'])throw new Error('Refusing to replace an unrecognized Motan output directory');}
  stage=await mkdtemp(join(parent,'.motan-build-'));
  const result=spawnSync(process.execPath,[join(host,'node_modules/typescript/bin/tsc'),'-p',resolve(config),'--outDir',stage],{stdio:'pipe',encoding:'utf8',timeout:60000,maxBuffer:4*1024**2});
  if(result.error||result.status!==0)throw new Error('Motan TypeScript build failed: '+(result.error?.message??result.stdout+result.stderr));
  for(const entry of ['scripts/motan/data_export.js','scripts/motan/motan_graph.js','host/src/motan/analysis-worker.js'])await access(join(stage,entry));
  const project=JSON.parse(await readFile(join(host,'package.json'),'utf8'));
  await writeFile(join(stage,'package.json'),JSON.stringify({name:project.name,type:'module',private:true,engines:project.engines,dependencies:project.dependencies},null,2)+'\n');
  await writeFile(join(stage,'COPYING'),await readFile(join(host,'../COPYING')));
  await copyFile(join(host,'package-lock.json'),join(stage,'package-lock.json'));
  await cp(join(host,'licenses'),join(stage,'host/licenses'),{recursive:true});
  await cp(join(host,'assets'),join(stage,'host/assets'),{recursive:true});
  const files:Record<string,string>={};
  const inventory=async(dir:string):Promise<void>=>{for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){const path=join(dir,entry.name);if(entry.isDirectory())await inventory(path);else files[relative(stage!,path).replaceAll('\\','/')]=createHash('sha256').update(await readFile(path)).digest('hex');}};
  await inventory(stage);
  const typescript=JSON.parse(await readFile(join(host,'node_modules/typescript/package.json'),'utf8')).version;
  await writeFile(join(stage,'build-info.json'),JSON.stringify({schema:1,node:process.version,typescript,files},null,2)+'\n');
  // The previous successful build survives compiler failure. Publishing uses
  // two directory renames; this is not a live-release switch or power-loss guarantee.
  backup=join(lock,'previous');
  try{await rename(target,backup);oldMoved=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  try{await rename(stage,target);stage=undefined;published=true;}catch(error){if(oldMoved){await rename(backup,target);oldMoved=false;}throw error;}
 }finally{
  if(stage)await rm(stage,{recursive:true,force:true});
  // If restoration itself failed, retain the lock and previous tree for recovery.
  if(!oldMoved||published)await rm(lock,{recursive:true,force:true});
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{if(process.argv.length>3)throw new Error('Usage: node host/scripts/build-motan.ts [output-directory]');await buildMotan(process.argv[2]);}
 catch(error){process.stderr.write((error instanceof Error?error.message:String(error))+'\n');process.exitCode=1;}
}
