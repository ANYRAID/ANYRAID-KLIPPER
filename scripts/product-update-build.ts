#!/usr/bin/env node
// Trusted preparation worker. Its parent owns the complete process group.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile,mkdir,cp,lstat,realpath,writeFile} from 'node:fs/promises';
import {join,dirname,isAbsolute,relative,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {installProductDependencies} from '../host/src/runtime/product-install.ts';
import {guardProductBuild} from '../host/src/runtime/product-update-preparation.ts';
import {fileURLToPath} from 'node:url';
import type {ProductBuildTools} from '../host/src/runtime/product-update-preparation.ts';
const controller=new AbortController(),stop=()=>controller.abort();process.on('SIGTERM',stop);process.on('SIGINT',stop);
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
async function main(){
 if(process.platform!=='linux'||process.argv.length!==4||process.argv[2]!=='--build-worker')throw Error('worker_configuration');
 const r=JSON.parse(await readFile(process.argv[3]!,'utf8')) as {schema:1;work:string;source:string;bundle:string;tools:ProductBuildTools;offline:boolean};
 if(r.schema!==1||!isAbsolute(r.work)||r.source!==join(r.work,'source')||r.bundle!==join(r.work,'generation')||await realpath(r.work)!==r.work||await realpath(r.source)!==r.source)throw Error('worker_configuration');
 const tools:Record<string,string>={};for(const name of ['npm','cc','cargo','rustc'] as const){const path=await realpath(r.tools[name]),s=await lstat(path);if(!s.isFile()||s.size>128*1024**2)throw Error('worker_tool');tools[name]=hash(await readFile(path));}
 const home=join(r.work,'home'),npmCache=join(r.work,'npm-cache'),cargoHome=join(r.work,'cargo-home'),temporary=join(r.work,'tmp');for(const p of[home,npmCache,cargoHome,temporary])await mkdir(p,{mode:0o700});const user=join(home,'user.npmrc'),global=join(home,'global.npmrc');await writeFile(user,'');await writeFile(global,'');
 // Seed only content caches, never user npmrc/Cargo config/credentials or old outputs.
 const copyCache=async(from:string,to:string)=>{const root=await realpath(from);await cp(root,to,{recursive:true,dereference:false,filter:async path=>{const s=await lstat(path);if(s.isSymbolicLink()||!s.isDirectory()&&!s.isFile())throw Error('cache_entry');return true;}});};
 if(r.tools.npmCacheSeed)await copyCache(join(r.tools.npmCacheSeed,'_cacache'),join(npmCache,'_cacache'));
 if(r.tools.cargoCacheSeed)await copyCache(join(r.tools.cargoCacheSeed,'registry'),join(cargoHome,'registry'));
 const env:NodeJS.ProcessEnv={HOME:home,TMPDIR:temporary,PATH:[dirname(process.execPath),dirname(r.tools.cc),dirname(r.tools.cargo),dirname(r.tools.rustc),'/usr/bin','/bin'].filter((x,i,a)=>a.indexOf(x)===i).join(':'),LANG:'C',LC_ALL:'C',NODE_OPTIONS:'--no-experimental-strip-types',NODE_PATH:'',NODE_DISABLE_COMPILE_CACHE:'1',CC:r.tools.cc,CARGO:r.tools.cargo,RUSTC:r.tools.rustc,NODE_INCLUDE:r.tools.nodeHeaders,CARGO_HOME:cargoHome,CARGO_NET_OFFLINE:r.offline?'true':'false',CARGO_BUILD_JOBS:'1',npm_config_userconfig:user,npm_config_globalconfig:global,npm_config_cache:npmCache,npm_config_registry:'https://registry.npmjs.org/',npm_config_ignore_scripts:'true',npm_config_fund:'false',npm_config_audit:'false',npm_config_update_notifier:'false'};
 // This dedicated worker may block. The product parent remains asynchronous.
 await writeFile(join(r.work,'phase.json'),JSON.stringify({phase:'build-dependencies'}));const install=spawnSync(process.execPath,[r.tools.npm,'ci','--include=dev','--include=optional','--ignore-scripts','--no-audit','--no-fund',...r.offline?['--offline']:[]],{cwd:join(r.source,'host'),env,timeout:180000,maxBuffer:2*1024**2});if(install.error||install.status!==0)throw Error('build_dependency_install');
 for(const key of Object.keys(process.env))delete process.env[key];Object.assign(process.env,env);
 // Source commit and recipe hashes were approved by the parent before this import.
 const build=await import(pathToFileURL(join(r.source,'host/scripts/build-product-host.ts')).href) as {productBuildCapabilities?:{schema:number;supervisedGroup:boolean;freshNative:boolean};buildProductHost:(output:string,config:undefined,native:undefined,signal:AbortSignal,preparation:{supervisedGroup:true;freshNative:true})=>Promise<void>};if(build.productBuildCapabilities?.schema!==1||!build.productBuildCapabilities.supervisedGroup||!build.productBuildCapabilities.freshNative)throw Error('unsupported_product_recipe');
 await writeFile(join(r.work,'phase.json'),JSON.stringify({phase:'typescript-native'}));await build.buildProductHost(r.bundle,undefined,undefined,controller.signal,{supervisedGroup:true,freshNative:true});
 await writeFile(join(r.work,'phase.json'),JSON.stringify({phase:'production-dependencies'}));await installProductDependencies(r.bundle,controller.signal,r.tools.npm,{env,offline:r.offline,deferCleanup:true});
 // Import only the no-hardware smoke. Never import profiles, start services or open printer transports.
 const smoke=`import{createRequire}from'node:module';import{Worker}from'node:worker_threads';const require=createRequire(import.meta.url);for(const n of ['trapq','stepcompress','serialqueue','unix-peer','sealed-file','file-events','can-query','ar100-flash','template'])require('./host/build/'+n+'.node');const sharp=(await import('sharp')).default;const b=await sharp({create:{width:2,height:2,channels:3,background:'red'}}).png().toBuffer();if(b.length<20)throw Error('image smoke');await new Promise((resolve,reject)=>{const w=new Worker(new URL('./smoke-worker.mjs',import.meta.url));w.once('message',n=>n===42?resolve():reject(Error('worker result')));w.once('error',reject);w.once('exit',n=>{if(n!==0)reject(Error('worker exit'));});});`;
 await writeFile(join(r.work,'phase.json'),JSON.stringify({phase:'smoke'}));await writeFile(join(r.bundle,'smoke-worker.mjs'),"import{parentPort}from'node:worker_threads';parentPort.postMessage(42);\n");await writeFile(join(r.bundle,'smoke.mjs'),smoke);const checked=spawnSync(process.execPath,['--no-experimental-strip-types',join(r.bundle,'smoke.mjs')],{cwd:r.bundle,env,timeout:15000,maxBuffer:1024**2});if(checked.error||checked.status!==0)throw Error('product_smoke');
 // Smoke files are explicitly inventoried too; no post-seal mutations occur.
 const native=JSON.parse(await readFile(join(r.bundle,'host/build/native-build-info.json'),'utf8'));tools.compilerVersion=native.compiler;tools.cargoVersion=native.rustToolchain.cargo;tools.rustcVersion=native.rustToolchain.rustc;await writeFile(join(r.work,'tools.json'),JSON.stringify(tools)+'\n');
}
try{if(process.argv.length===3){const r=JSON.parse(await readFile(process.argv[2]!,'utf8'));await guardProductBuild(process.execPath,[fileURLToPath(import.meta.url),'--build-worker',process.argv[2]!],r.drain);}else await main();}catch(e){const code=e instanceof Error&&/^[a-z_]+$/u.test(e.message)?e.message:'worker_failed';process.stderr.write(code+'\n');process.exitCode=1;}finally{process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);}
