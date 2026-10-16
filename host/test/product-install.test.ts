import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {inspect} from 'node:util';
import {installProductDependencies,productInstallCLI} from '../src/runtime/product-install.ts';
async function fixture(run:(root:string,npm:string)=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'product-install-'));
 try{
  await mkdir(join(root,'scripts'));const content={'scripts/product-host.js':'throw new Error("must not start");','package.json':JSON.stringify({dependencies:{example:'1.0.0'}}),'package-lock.json':'{}'};
  for(const [name,text] of Object.entries(content))await writeFile(join(root,name),text);
  await writeFile(join(root,'build-info.json'),JSON.stringify({schema:1,product:'anyraid-product-host',platform:process.platform,arch:process.arch,modules:process.versions.modules,files:Object.fromEntries(Object.entries(content).map(([k,v])=>[k,createHash('sha256').update(v).digest('hex')]))}));
  const npm=join(root,'fake-npm.mjs');await writeFile(npm,`import {mkdir,writeFile} from 'node:fs/promises';await writeFile('../observed.json',JSON.stringify({args:process.argv.slice(2),path:process.env.PATH,nodeOptions:process.env.NODE_OPTIONS}));await mkdir('node_modules/example',{recursive:true});`);await run(root,npm);
 }finally{await rm(root,{recursive:true,force:true});}
}
test('fresh installer validates bundle and runs npm with production-only no-script settings',()=>fixture(async(root,npm)=>{
 const result=await installProductDependencies(root,new AbortController().signal,npm);assert.equal(result.dependencies,1);assert(result.durationMs>0);
 const observed=JSON.parse(await readFile(join(root,'observed.json'),'utf8'));assert.deepEqual(observed.args,['ci','--omit=dev','--include=optional','--ignore-scripts','--no-audit','--no-fund']);assert.equal(observed.path,'/no-programs');assert.equal(observed.nodeOptions,'--no-experimental-strip-types');
 await assert.rejects(lstat(join(root,'.dependency-install.lock')),{code:'ENOENT'});await assert.rejects(installProductDependencies(root,new AbortController().signal,npm),/already exist/);assert((await lstat(join(root,'node_modules/example'))).isDirectory());
}));
test('tampering, competing install and cancellation do not execute npm',()=>fixture(async(root,npm)=>{
 const controller=new AbortController();controller.abort(new Error('cancelled'));await assert.rejects(installProductDependencies(root,controller.signal,npm),/cancelled/);
 await mkdir(join(root,'.dependency-install.lock'));await assert.rejects(installProductDependencies(root,new AbortController().signal,npm),{code:'EEXIST'});await rm(join(root,'.dependency-install.lock'),{recursive:true});
 await writeFile(join(root,'package-lock.json'),'tampered');await assert.rejects(installProductDependencies(root,new AbortController().signal,npm),/digest mismatch/);await assert.rejects(lstat(join(root,'observed.json')),{code:'ENOENT'});
}));
test('installer help and invalid arguments require no bundle or npm execution',async()=>{
 let output='';await productInstallCLI(['--help'],new AbortController().signal,t=>{output+=t;});assert.match(output,/Does not start/);
 for(const args of [[],['--bundle'],['--install','yes'],['--bundle','/a','--bundle','/b']])await assert.rejects(productInstallCLI(args,new AbortController().signal,()=>assert.fail()),/Expected/);
});
test('failed install removes partial dependencies and permits a fresh retry',()=>fixture(async(root,npm)=>{
 const original=await readFile(npm,'utf8');
 await writeFile(npm,"import {mkdir} from 'node:fs/promises';await mkdir('node_modules/partial',{recursive:true});process.exitCode=9;");
 await assert.rejects(installProductDependencies(root,new AbortController().signal,npm));
 await assert.rejects(lstat(join(root,'node_modules')),{code:'ENOENT'});await assert.rejects(lstat(join(root,'.dependency-install.lock')),{code:'ENOENT'});
 await writeFile(npm,original);await installProductDependencies(root,new AbortController().signal,npm);assert((await lstat(join(root,'node_modules/example'))).isDirectory());
}));
test('npm failure retains an actionable category while discarding registry credentials and partial output',()=>fixture(async(root,npm)=>{
 const original=await readFile(npm,'utf8');
 for(const [line,expected] of [['npm error code ENOTFOUND','ENOTFOUND'],['npm ERR! code EINTEGRITY','EINTEGRITY'],['npm error code EPRIVATE_SYNTHETIC',null]] as const){
  await writeFile(npm,"import {mkdir} from 'node:fs/promises';await mkdir('node_modules/partial',{recursive:true});console.error("+JSON.stringify(line+'\nnpm error https://synthetic-user:synthetic-secret@registry.test/private?token=synthetic-token')+");console.log('synthetic-private-output');process.exitCode=9;");
  await assert.rejects(installProductDependencies(root,new AbortController().signal,npm),error=>{
   const failure=error as Error&{code:string;exitCode:number;signal:null;npmCode:string|null};assert.equal(failure.code,'ERR_PRODUCT_DEPENDENCY_INSTALL');assert.equal(failure.exitCode,9);assert.equal(failure.signal,null);assert.equal(failure.npmCode,expected);
   for(const value of [String(failure),JSON.stringify(failure),inspect(failure)])for(const privateText of ['synthetic-user','synthetic-secret','synthetic-token','synthetic-private-output','EPRIVATE_SYNTHETIC'])assert(!value.includes(privateText));return true;
  });
  await assert.rejects(lstat(join(root,'node_modules')),{code:'ENOENT'});await assert.rejects(lstat(join(root,'.dependency-install.lock')),{code:'ENOENT'});
 }
 await writeFile(npm,original);await installProductDependencies(root,new AbortController().signal,npm);assert((await lstat(join(root,'node_modules/example'))).isDirectory());
}));
test('excessive npm diagnostics report an output limit without exposing data or publishing dependencies',()=>fixture(async(root,npm)=>{
 await writeFile(npm,"import {mkdir} from 'node:fs/promises';import {writeSync} from 'node:fs';await mkdir('node_modules/partial',{recursive:true});writeSync(2,'synthetic-private-output'.repeat(120000));");
 await assert.rejects(installProductDependencies(root,new AbortController().signal,npm),error=>{
  const failure=error as Error&{code:string;outputLimit:boolean;timedOut:boolean};assert.equal(failure.code,'ERR_PRODUCT_DEPENDENCY_INSTALL');assert.equal(failure.outputLimit,true);assert.equal(failure.timedOut,false);assert.match(failure.message,/output limit/);assert(!inspect(failure).includes('synthetic-private-output'));return true;
 });
 await assert.rejects(lstat(join(root,'node_modules')),{code:'ENOENT'});await assert.rejects(lstat(join(root,'.dependency-install.lock')),{code:'ENOENT'});
}));
test('cancelled installer joins its child before removing staging and retrying',()=>fixture(async(root,npm)=>{
 const original=await readFile(npm,'utf8'),controller=new AbortController();
 await writeFile(npm,"import {mkdir,writeFile} from 'node:fs/promises';process.on('SIGTERM',()=>{});await mkdir('node_modules/partial',{recursive:true});await writeFile('../started','ready');setInterval(()=>{},100);");
 const pending=installProductDependencies(root,controller.signal,npm);void pending.catch(()=>{});
 const deadline=Date.now()+10000;while(true){try{await lstat(join(root,'started'));break;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;if(Date.now()>deadline)throw new Error('npm fixture did not start');await new Promise(done=>setTimeout(done,10));}}
 await assert.rejects(lstat(join(root,'node_modules')),{code:'ENOENT'});
 controller.abort();await assert.rejects(pending,{name:'AbortError'});
 await assert.rejects(lstat(join(root,'.dependency-install.lock')),{code:'ENOENT'});
 await writeFile(npm,original);await installProductDependencies(root,new AbortController().signal,npm);
}));
test('changed staged manifest and missing dependency prevent publication',()=>fixture(async(root,npm)=>{
 const original=await readFile(npm,'utf8');
 await writeFile(npm,original+"await writeFile('package-lock.json','changed');");
 await assert.rejects(installProductDependencies(root,new AbortController().signal,npm),/manifest changed/);
 await assert.rejects(lstat(join(root,'node_modules')),{code:'ENOENT'});
 await writeFile(npm,"import {mkdir} from 'node:fs/promises';await mkdir('node_modules');");
 await assert.rejects(installProductDependencies(root,new AbortController().signal,npm),{code:'ENOENT'});
 await assert.rejects(lstat(join(root,'node_modules')),{code:'ENOENT'});
}));
