import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {access,copyFile,lstat,mkdir,readFile,rename,rm} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {verifyProductBundle} from './product-service-unit.ts';
const execute=promisify(execFile);
/** Explicit fresh production dependency install. Does not replace an existing
 * dependency tree, import machine modules, touch services or open hardware. */
export async function installProductDependencies(output:string,signal:AbortSignal,npmPath?:string):Promise<{durationMs:number;dependencies:number}>{
 signal.throwIfAborted();const bundle=await verifyProductBundle(output),lock=join(bundle,'.dependency-install.lock');
 const inventory=JSON.parse(await readFile(join(bundle,'build-info.json'),'utf8'));
 if(!inventory.files['package.json']||!inventory.files['package-lock.json'])throw new Error('Product install requires inventoried package and lock files');
 await mkdir(lock);
 try{
  try{await lstat(join(bundle,'node_modules'));throw new Error('Product dependencies already exist');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const npm=npmPath??process.env.npm_execpath??join(dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js');
  if(!isAbsolute(npm)||/[\x00-\x1f\x7f]/u.test(npm))throw new TypeError('npm CLI requires an absolute path');await access(npm);signal.throwIfAborted();
  // Keep incomplete downloads invisible to the runnable bundle. The lock is on
  // the same filesystem so publication can rename the completed tree.
  for(const name of ['package.json','package-lock.json'])await copyFile(join(bundle,name),join(lock,name));
  const begin=performance.now(),env={...process.env,PATH:'/no-programs',NODE_OPTIONS:'--no-experimental-strip-types',NODE_PATH:'',NODE_DISABLE_COMPILE_CACHE:'1'};
  const pending=execute(process.execPath,[resolve(npm),'ci','--omit=dev','--include=optional','--ignore-scripts','--no-audit','--no-fund'],{cwd:lock,env,signal,timeout:120000,maxBuffer:2*1024**2});
  const closed=new Promise<void>(done=>pending.child.once('close',()=>done()));
  try{await pending;}catch(error){pending.child.kill('SIGKILL');await closed;throw error;}
  await closed;
  signal.throwIfAborted();const tree=await lstat(join(lock,'node_modules'));if(!tree.isDirectory()||tree.isSymbolicLink())throw new Error('Product dependencies must be independently installed');
  const project=JSON.parse(await readFile(join(bundle,'package.json'),'utf8'));
  for(const name of Object.keys(project.dependencies)){const dependency=await lstat(join(lock,'node_modules',name));if(!dependency.isDirectory()||dependency.isSymbolicLink())throw new Error('Product dependency is not an independent directory: '+name);}
  await verifyProductBundle(bundle);
  for(const name of ['package.json','package-lock.json'])if(!(await readFile(join(bundle,name))).equals(await readFile(join(lock,name))))throw new Error('Product install manifest changed: '+name);
  signal.throwIfAborted();
  try{await lstat(join(bundle,'node_modules'));throw new Error('Product dependencies already exist');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  await rename(join(lock,'node_modules'),join(bundle,'node_modules'));
  return {durationMs:performance.now()-begin,dependencies:Object.keys(project.dependencies).length};
 }finally{await rm(lock,{recursive:true,force:true});}
}
export async function productInstallCLI(args:readonly string[],signal:AbortSignal,write:(text:string)=>void){
 if(args.length===1&&['--help','-h'].includes(args[0])){write('Usage: node scripts/product-install.js --bundle /absolute/product-host [--npm /absolute/npm-cli.js]\nInstalls fresh locked production dependencies without lifecycle scripts. Does not start services.\n');return;}
 const options:Record<string,string>={};for(let i=0;i<args.length;i+=2){const key=args[i];if(!['--bundle','--npm'].includes(key)||key in options||!args[i+1])throw new Error('Expected --bundle and optional --npm');options[key]=args[i+1];}
 if(!options['--bundle'])throw new Error('Expected --bundle and optional --npm');
 write(JSON.stringify(await installProductDependencies(options['--bundle'],signal,options['--npm']))+'\n');
}
