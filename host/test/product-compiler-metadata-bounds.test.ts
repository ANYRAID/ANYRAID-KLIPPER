import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {captureProductCompilerInputs} from '../scripts/product-compiler-observation.ts';
const observerModule=new URL('../scripts/product-compiler-observation.ts',import.meta.url);

test('compiler metadata and config FIFOs or oversized package files cannot block the observer',{skip:process.platform==='win32'},async()=>{
 for(const kind of ['package-fifo','native-package-fifo','config-fifo','package-large','native-package-large']){
  const dir=await mkdtemp(join(tmpdir(),'compiler-metadata-bounds-'));
  try{
   const pkg=join(dir,'node_modules/typescript'),native=join(dir,'node_modules/@typescript','typescript-'+process.platform+'-'+process.arch);await mkdir(pkg,{recursive:true});await mkdir(native,{recursive:true});
   const config=join(dir,'config.json'),packageFile=join(pkg,'package.json'),nativeFile=join(native,'package.json');
   const target=kind.startsWith('native-')?nativeFile:kind.startsWith('package-')?packageFile:config;
   for(const [file,text] of [[packageFile,'{"name":"typescript","version":"7.0.2"}'],[nativeFile,'{}'],[config,'{}']])if(file!==target)await writeFile(file,text);
   if(kind.endsWith('fifo'))execFileSync('mkfifo',[target]);else await writeFile(target,' '.repeat(64*1024+1));
   const script='import {captureProductCompilerInputs} from '+JSON.stringify(observerModule.href)+'; console.log(JSON.stringify(await captureProductCompilerInputs('+JSON.stringify(dir)+','+JSON.stringify(config)+')));';
   const env={...process.env};delete env.NODE_TEST_CONTEXT;
   // The outer child bound keeps a future accidental blocking open from hanging
   // the test runner. It does not change the compiler's original deadline.
   const result=spawnSync(process.execPath,['--input-type=module','-e',script],{env,encoding:'utf8',timeout:2000,killSignal:'SIGKILL',maxBuffer:16384});
   assert.ifError(result.error);assert.equal(result.status,0,result.stderr);
   const value=JSON.parse(result.stdout),role=kind.startsWith('native-')?'nativePackage':kind.startsWith('package-')?'package':'config';
   assert.deepEqual(value.files[role],{unavailable:'NOT_BOUNDED_FILE'},kind);
   if(kind!=='config-fifo')assert.deepEqual(value.files.nativeCandidate,{unavailable:'NOT_BOUNDED_FILE'},kind);
  }finally{await rm(dir,{recursive:true,force:true});}
 }
});
test('compiler candidate discovery follows the real installed package directory without parsing dependency exports',{skip:process.platform==='win32'},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'compiler-nested-package-'));
 try{
  const physical=join(dir,'store/compiler/node_modules/typescript'),native=join(dir,'store/compiler/node_modules/@typescript','typescript-'+process.platform+'-'+process.arch);
  await mkdir(physical,{recursive:true});await mkdir(join(native,'lib'),{recursive:true});await mkdir(join(dir,'node_modules'));
  await writeFile(join(physical,'package.json'),'{"name":"typescript","version":"7.0.2"}');await writeFile(join(native,'package.json'),'{}');await writeFile(join(native,'lib/tsc'),'fixture');
  await symlink(physical,join(dir,'node_modules/typescript'),'dir');
  const observed=await captureProductCompilerInputs(dir,join(dir,'config.json'));
  assert.equal(observed.typescript,'7.0.2');assert('sha256' in observed.files.nativeCandidate);assert.equal(observed.files.nativeCandidate.bytes,7);
 }finally{await rm(dir,{recursive:true,force:true});}
});
