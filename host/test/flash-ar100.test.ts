import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,open,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {parseAr100Args,runAr100Flash,type Ar100Mode} from '../src/diagnostics/flash-ar100-cli.ts';
// External flock/help processes do not exercise instrumented memory writes.
const childEnv={...process.env,LD_PRELOAD:undefined,ASAN_OPTIONS:undefined};
const require=createRequire(import.meta.url),native=require(process.env.ANYRAID_AR100_TEST_ADDON??'../build/ar100-flash-test.node') as {executeTest:(mode:string,data:Buffer,fd:number,fault:string)=>void};
const reference=JSON.parse(await readFile(new URL('../contracts/ar100/flash-reference.json',import.meta.url),'utf8')) as {cases:{mode:Ar100Mode;size:number;sramSha256:string;reset:number}[]};
const firmware=(size:number)=>Buffer.from(Array.from({length:size},(_,i)=>(i*37+11)%256));
async function image(){const dir=await mkdtemp(join(tmpdir(),'ar100-image-')),file=await open(join(dir,'memory'),'wx+');await file.truncate(0x1f02000);return {dir,file,async reset(){await file.write(Buffer.alloc(0x14000,165),0,0x14000,0x40000);await file.write(Buffer.from([165]),0,1,0x1f01c00);},async snapshot(){const sram=Buffer.alloc(0x14000),reset=Buffer.alloc(1);await file.read(sram,0,sram.length,0x40000);await file.read(reset,0,1,0x1f01c00);return {sram,reset:reset[0]};},async close(){await file.close();await rm(dir,{recursive:true,force:true});}};}
test('AR100 fixed MMIO writes match retired Python snapshots for every operation and size boundary',async()=>{
 const f=await image();try{for(const c of reference.cases){await f.reset();native.executeTest(c.mode,firmware(c.size),f.file.fd,'');const actual=await f.snapshot();assert.equal(createHash('sha256').update(actual.sram).digest('hex'),c.sramSha256,c.mode);assert.equal(actual.reset,c.reset,c.mode);assert.deepEqual(actual.sram.subarray(0x2000,0x4000),Buffer.alloc(0x2000,165));}}finally{await f.close();}
});
test('AR100 failures after reset, vectors, writes, verification or release keep CPU reset and preserve other reset bits',async()=>{
 const f=await image();try{for(const fault of ['after-reset','after-vectors','after-write','verify','release']){await f.reset();assert.throws(()=>native.executeTest('flash',firmware(65536),f.file.fd,fault));assert.equal((await f.snapshot()).reset,164);}}finally{await f.close();}
});
test('AR100 native boundary rejects invalid calls and short images without writes; production has no test entry',async()=>{
 const f=await image();try{await f.reset();const before=await f.snapshot();for(const [mode,data,fd] of [['unknown',firmware(1),f.file.fd],['flash',Buffer.alloc(0),f.file.fd],['flash',Buffer.alloc(65537),f.file.fd],['reset',firmware(1),f.file.fd],['halt',Buffer.alloc(0),-1],['halt',Buffer.alloc(0),NaN]] as [string,Buffer,number][]){assert.throws(()=>native.executeTest(mode,data,fd,''));}assert.deepEqual(await f.snapshot(),before);await f.file.truncate(100);assert.throws(()=>native.executeTest('halt',Buffer.alloc(0),f.file.fd,''),/image/);assert.equal(require('../build/ar100-flash.node').executeTest,undefined);}finally{await f.close();}
});
test('AR100 memory lock excludes another open description before reset or writes',async()=>{
 const f=await image();try{await f.reset();const child=spawnSync('flock',['-n',join(f.dir,'memory'),process.execPath,'--input-type=module','-e',`import {createRequire} from 'node:module';import {openSync} from 'node:fs';const n=createRequire(import.meta.url)(${JSON.stringify(require.resolve('../build/ar100-flash-test.node'))});try{n.executeTest('halt',Buffer.alloc(0),openSync(process.argv[1],'r+'),'');process.exitCode=2;}catch(e){if(!/already in use/.test(e.message))throw e;}`,join(f.dir,'memory')],{encoding:'utf8',env:childEnv});assert.equal(child.status,0,child.stderr);assert.equal((await f.snapshot()).reset,165);}finally{await f.close();}
});
test('AR100 CLI validates all input before hardware and loads read-only files without modifying source',async()=>{
 const f=await image();let calls=0;const execute=()=>{calls++;},signal=new AbortController().signal;try{const source=join(f.dir,'firmware');await writeFile(source,firmware(512),{mode:0o400});let received:Buffer|undefined;await runAr100Flash([source],signal,()=>{},(mode,data)=>{assert.equal(mode,'flash');received=data;});assert.deepEqual(received,firmware(512));assert.deepEqual(await readFile(source),firmware(512));await writeFile(join(f.dir,'empty'),'');await writeFile(join(f.dir,'large'),Buffer.alloc(65537));await symlink(source,join(f.dir,'link'));for(const name of ['empty','large','missing','link','.'])await assert.rejects(runAr100Flash([join(f.dir,name)],signal,()=>{},execute));const abort=AbortSignal.abort(new Error('stop'));await assert.rejects(runAr100Flash([source],abort,()=>{},execute),/stop/);for(const args of [[],['--bl31'],['--reset',source],['--reset','--halt'],[source,'other'],['--unknown']])await assert.rejects(runAr100Flash(args,signal,()=>{},execute));assert.equal(calls,0);assert.deepEqual(parseAr100Args(['--halt',source]),{mode:'flash-halt',filename:source});assert.deepEqual(parseAr100Args(['--bl31','--halt',source]),{mode:'bl31-halt',filename:source});assert.equal(parseAr100Args(['--help']),null);}finally{await f.close();}
});
test('AR100 executable help requires neither Python nor native memory access',()=>{
 const result=spawnSync(process.execPath,[new URL('../../scripts/flash-ar100.ts',import.meta.url).pathname,'--help'],{encoding:'utf8',env:childEnv});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Allwinner A64 only/);
});
test('AR100 halt and bl31 modes never enter reset release even when combined with a file',async()=>{
 const f=await image();try{for(const mode of ['halt','flash-halt','bl31','bl31-halt']){await f.reset();native.executeTest(mode,mode==='halt'?Buffer.alloc(0):firmware(128),f.file.fd,'release');assert.equal((await f.snapshot()).reset,164);}}finally{await f.close();}
});
