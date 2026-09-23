import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile,readdir,rename,rm,lstat,copyFile,cp,access} from 'node:fs/promises';
import {dirname,join,resolve,relative} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const host=fileURLToPath(new URL('..',import.meta.url));
const requiredAddons=['trapq','stepcompress','serialqueue','unix-peer','sealed-file','can-query','ar100-flash'];
/** Build into a private staging directory; replace only a recognized, offline
 * generated tree. Native addons must have been built for the deployment target. */
export async function buildProductHost(output=join(host,'build/product-host'),config=join(host,'tsconfig.product-host.json'),nativeDirectory=join(host,'build')):Promise<void>{
 const [major,minor]=process.versions.node.split('.').map(Number);if(major!==26||minor<9)throw new Error('Product build requires Node.js 26.9 or later 26.x');
 const target=resolve(output),parent=dirname(target),lock=target+'.lock';await mkdir(parent,{recursive:true});
 try{await mkdir(lock);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error('Product build destination is locked: '+lock);throw error;}
 let stage:string|undefined,oldMoved=false,published=false;
 try{
  let present=false;try{const info=await lstat(target);present=true;if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Product output must be a generated directory');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(present){let marker;try{marker=JSON.parse(await readFile(join(target,'build-info.json'),'utf8'));}catch{throw new Error('Refusing to replace an unrecognized product output');}if(marker?.schema!==1||marker.product!=='anyraid-product-host'||!marker.files?.['scripts/product-host.js'])throw new Error('Refusing to replace an unrecognized product output');}
  stage=await mkdtemp(join(parent,'.product-build-'));
  const result=spawnSync(process.execPath,[join(host,'node_modules/typescript/bin/tsc'),'-p',resolve(config),'--outDir',stage],{encoding:'utf8',timeout:60000,maxBuffer:4*1024**2});
  if(result.error||result.status!==0)throw new Error('Product TypeScript build failed: '+(result.error?.message??result.stdout+result.stderr));
  for(const entry of ['scripts/product-host.js','host/src/runtime/product-host.js','host/src/operations/print-journal-worker.js','host/src/moonraker/database-worker.js','host/src/moonraker/metadata-extractor-worker.js','host/src/moonraker/file-list-worker.js','host/src/moonraker/thumbnail-process-child.js','host/src/calibration/spectrum-worker.js','host/src/calibration/shaper-fit-worker.js'])await access(join(stage,entry));
  const addons=[...requiredAddons];try{await access(join(nativeDirectory,'template.node'));addons.push('template');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  await mkdir(join(stage,'host/build'),{recursive:true});
  for(const name of addons){const file=join(nativeDirectory,name+'.node'),info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size===0)throw new Error('Invalid native addon: '+name);await copyFile(file,join(stage,'host/build',name+'.node'));}
  const project=JSON.parse(await readFile(join(host,'package.json'),'utf8'));
  await writeFile(join(stage,'package.json'),JSON.stringify({name:project.name,private:true,type:'module',engines:project.engines,dependencies:project.dependencies,scripts:{start:'node scripts/product-host.js'}},null,2)+'\n');
  await copyFile(join(host,'package-lock.json'),join(stage,'package-lock.json'));
  await copyFile(join(host,'../COPYING'),join(stage,'COPYING'));
  await cp(join(host,'licenses'),join(stage,'host/licenses'),{recursive:true});
  await cp(join(host,'assets'),join(stage,'host/assets'),{recursive:true});
  const files:Record<string,string>={};
  const inventory=async(dir:string):Promise<void>=>{for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){const path=join(dir,entry.name);if(entry.isDirectory())await inventory(path);else{if(!entry.isFile())throw new Error('Unexpected product build entry');files[relative(stage!,path).replaceAll('\\','/')]=createHash('sha256').update(await readFile(path)).digest('hex');}}};
  await inventory(stage);const typescript=JSON.parse(await readFile(join(host,'node_modules/typescript/package.json'),'utf8')).version;
  await writeFile(join(stage,'build-info.json'),JSON.stringify({schema:1,product:'anyraid-product-host',node:process.version,typescript,platform:process.platform,arch:process.arch,modules:process.versions.modules,addons,files},null,2)+'\n');
  const backup=join(lock,'previous');try{await rename(target,backup);oldMoved=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  try{await rename(stage,target);stage=undefined;published=true;}catch(error){if(oldMoved){await rename(backup,target);oldMoved=false;}throw error;}
 }finally{
  if(stage)await rm(stage,{recursive:true,force:true});
  // A failed restoration leaves the prior build in the lock for recovery.
  if(!oldMoved||published)await rm(lock,{recursive:true,force:true});
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{if(process.argv.length>3)throw new Error('Usage: node host/scripts/build-product-host.ts [output-directory]');await buildProductHost(process.argv[2]);}
 catch(error){process.stderr.write((error instanceof Error?error.message:String(error))+'\n');process.exitCode=1;}
}
