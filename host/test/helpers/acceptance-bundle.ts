import {createHash} from 'node:crypto';
import {lstat,readFile,readdir,readlink,realpath} from 'node:fs/promises';
import {isAbsolute,join,relative,sep} from 'node:path';
import {verifyProductBundle} from '../../src/runtime/product-service-unit.ts';

export interface AcceptanceBundle {readonly path:string;readonly manifestSha256:string;readonly dependenciesSha256:string;}
function inside(parent:string,child:string){const rel=relative(parent,child);return rel===''||!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep);}
/** Read-only identity of one compiled/installed product. Never rebuilds,
 * installs, imports a profile or touches machine state. Dependencies are bound
 * separately because they are installed after the production inventory. */
export async function inspectAcceptanceBundle(input:string):Promise<AcceptanceBundle>{
 const path=await verifyProductBundle(input),modules=join(path,'node_modules'),root=await lstat(modules);
 if(!root.isDirectory()||root.isSymbolicLink())throw new Error('Acceptance dependencies must be independently installed');
 const project=JSON.parse(await readFile(join(path,'package.json'),'utf8')),lock=JSON.parse(await readFile(join(path,'package-lock.json'),'utf8'));
 for(const name of ['typescript','minijinja-js']){
  try{await lstat(join(modules,name));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
  throw new Error('Acceptance bundle contains development dependency: '+name);
 }
 for(const name of Object.keys(project.dependencies)){
  const dependency=await lstat(join(modules,name));
  if(!dependency.isDirectory()||dependency.isSymbolicLink())throw new Error('Acceptance dependency is not an independent directory: '+name);
  const actual=JSON.parse(await readFile(join(modules,name,'package.json'),'utf8')).version;
  if(actual!==lock.packages?.['node_modules/'+name]?.version)throw new Error('Acceptance dependency version differs from lock: '+name);
 }
 const hash=createHash('sha256');hash.update('anyraid-acceptance-dependencies-v1\0');
 const inventory=async(dir:string):Promise<void>=>{
  for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
   const file=join(dir,entry.name),name=relative(modules,file).replaceAll('\\','/');
   if(entry.isDirectory()){hash.update('directory\0'+name+'\0');await inventory(file);}
   else if(entry.isFile())hash.update('file\0'+name+'\0'+createHash('sha256').update(await readFile(file)).digest('hex')+'\0');
   else if(entry.isSymbolicLink()){
    const target=await readlink(file);if(isAbsolute(target)||!inside(modules,await realpath(file)))throw new Error('Acceptance dependency link escapes installed tree: '+name);
    hash.update('link\0'+name+'\0'+target+'\0');
   }else throw new Error('Unexpected acceptance dependency entry: '+name);
  }
 };
 await inventory(modules);
 return {path,manifestSha256:createHash('sha256').update(await readFile(join(path,'build-info.json'))).digest('hex'),dependenciesSha256:hash.digest('hex')};
}
/** All three values are required together; absence preserves the existing
 * fresh-build tests. A bad identity fails rather than silently rebuilding. */
export async function externalAcceptanceBundle(env:NodeJS.ProcessEnv=process.env):Promise<AcceptanceBundle|undefined>{
 const path=env.ANYRAID_ACCEPTANCE_BUNDLE,manifest=env.ANYRAID_ACCEPTANCE_MANIFEST_SHA256,dependencies=env.ANYRAID_ACCEPTANCE_DEPENDENCIES_SHA256;
 if(path===undefined&&manifest===undefined&&dependencies===undefined)return;
 if(!path||!manifest||!dependencies||![manifest,dependencies].every(s=>/^[a-f0-9]{64}$/.test(s)))throw new Error('Acceptance reuse requires bundle, manifest SHA-256 and dependency SHA-256');
 const bundle=await inspectAcceptanceBundle(path);
 if(bundle.manifestSha256!==manifest||bundle.dependenciesSha256!==dependencies)throw new Error('Acceptance bundle identity changed');
 return bundle;
}
/** Fixture cleanup must never delete the retained package, and test profiles,
 * configuration and runtime data must never be written inside that package. */
export async function assertSeparateAcceptanceWorkspace(bundle:AcceptanceBundle,workspace:string){
 const dir=await realpath(workspace);if(inside(dir,bundle.path)||inside(bundle.path,dir))throw new Error('Acceptance workspace overlaps retained bundle');
}

/** Recheck the pinned identity even if the caller's environment was changed. */
export async function assertAcceptanceBundleUnchanged(expected:AcceptanceBundle):Promise<void>{
 const actual=await inspectAcceptanceBundle(expected.path);
 if(actual.manifestSha256!==expected.manifestSha256||actual.dependenciesSha256!==expected.dependenciesSha256)throw new Error('Acceptance bundle identity changed');
}
