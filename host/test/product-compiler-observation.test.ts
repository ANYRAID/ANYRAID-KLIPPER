import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm,readdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {captureProductCompilerInputs,productCompilerFailure} from '../scripts/product-compiler-observation.ts';
import {buildProductHost} from '../scripts/build-product-host.ts';
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');

test('compiler inputs bind installed bytes without executing or caching the candidate',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'compiler-inputs-'));
 try{
  const pkg=join(dir,'node_modules/typescript'),native=join(dir,'node_modules/@typescript','typescript-'+process.platform+'-'+process.arch);
  for(const path of [join(pkg,'bin'),join(pkg,'lib'),join(native,'lib')])await mkdir(path,{recursive:true});
  await writeFile(join(pkg,'package.json'),'{"name":"typescript","version":"7.0.2"}');
  await writeFile(join(native,'package.json'),'{}');
  const binary=join(native,'lib',process.platform==='win32'?'tsc.exe':'tsc');
  await writeFile(binary,'not executable; never launch this fixture');
  await writeFile(join(pkg,'bin/tsc'),'entry');await writeFile(join(pkg,'lib/tsc.js'),'wrapper');await writeFile(join(pkg,'lib/getExePath.js'),'resolver');
  const config=join(dir,'tsconfig.product-host.json');await writeFile(config,'{}');await writeFile(join(dir,'tsconfig.json'),'{}');await writeFile(join(dir,'package-lock.json'),'{}');
  const first=await captureProductCompilerInputs(dir,config);
  assert.equal(first.typescript,'7.0.2');assert.equal(first.node,process.version);
  assert.deepEqual(first.files.nativeCandidate,{bytes:41,sha256:sha('not executable; never launch this fixture')});
  assert.deepEqual(first.files.wrapper,{bytes:7,sha256:sha('wrapper')});
  assert.equal(Object.keys(first.files).length,9);
  await writeFile(binary,'changed');await rm(join(pkg,'lib/tsc.js'));await rm(join(dir,'package-lock.json'));await mkdir(join(dir,'package-lock.json'));
  const second=await captureProductCompilerInputs(dir,config);
  assert.deepEqual(second.files.nativeCandidate,{bytes:7,sha256:sha('changed')});
  assert.deepEqual(second.files.wrapper,{unavailable:'ENOENT'});
  assert.deepEqual(second.files.lock,{unavailable:'NOT_BOUNDED_FILE'});
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('missing compiler metadata does not prevent observing an existing compilation failure',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'compiler-missing-'));
 try{
  const inputs=await captureProductCompilerInputs(dir,join(dir,'config.json'));
  assert.equal(inputs.typescript,null);assert.deepEqual(inputs.files.entry,{unavailable:'ENOENT'});
  assert('unavailable' in inputs.files.nativeCandidate);
  const error=productCompilerFailure({status:2,signal:null,error:undefined,stdout:'raw out\n',stderr:'raw err\n'},inputs);
  assert(error.message.startsWith('Product TypeScript build failed: raw out\nraw err\n\nproductCompilerFailure='));
  assert(error.message.length<8192);assert(!error.message.includes(dir));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('actual child exit, signal and timeout retain their distinct spawn outcomes',()=>{
 const inputs={schema:1 as const,node:process.version,platform:process.platform,arch:process.arch,typescript:null,files:{}};
 for(const [script,options,expected] of [
  ['process.stdout.write("out");process.stderr.write("err");process.exit(17)',{}, {status:17,signal:null,errorCode:null}],
  ['process.kill(process.pid,"SIGTERM")',{}, {status:null,signal:'SIGTERM',errorCode:null}],
  ['setInterval(()=>{},1000)',{timeout:100}, {status:null,signal:'SIGTERM',errorCode:'ETIMEDOUT'}],
 ] as const){
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const result=spawnSync(process.execPath,['-e',script],{env,encoding:'utf8',...options});
  const message=productCompilerFailure(result,inputs).message;
  const metadata=JSON.parse(message.split('\nproductCompilerFailure=')[1]);
  for(const [key,value] of Object.entries(expected))assert.equal(metadata[key],value);
  if(expected.status===17)assert(message.startsWith('Product TypeScript build failed: outerr\n'));
  assert.deepEqual(Object.keys(metadata).sort(),['arch','errorCode','files','node','platform','schema','scope','signal','status','typescript']);
 }
});
test('real TypeScript rejection carries pre-launch digests and cleans its private staging directory',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'compiler-rejection-'));
 try{
  const config=join(dir,'invalid.json'),text='{"compilerOptions":{"target":"invalid-target"},"files":[]}';await writeFile(config,text);
  let failure:Error|undefined;try{await buildProductHost(join(dir,'app'),config);}catch(error){failure=error as Error;}
  assert(failure);assert.match(failure.message,/Product TypeScript build failed:.*error TS/s);
  const observation=JSON.parse(failure.message.split('\nproductCompilerFailure=')[1]);
  assert.notEqual(observation.status,0);assert.equal(observation.signal,null);assert.equal(observation.errorCode,null);
  assert.deepEqual(observation.files.config,{bytes:Buffer.byteLength(text),sha256:sha(text)});
  const host=fileURLToPath(new URL('..',import.meta.url));
  assert.deepEqual(observation.files.wrapper,{bytes:(await readFile(join(host,'node_modules/typescript/lib/tsc.js'))).length,sha256:createHash('sha256').update(await readFile(join(host,'node_modules/typescript/lib/tsc.js'))).digest('hex')});
  assert.deepEqual(await readdir(dir),['invalid.json']);
 }finally{await rm(dir,{recursive:true,force:true});}
});
