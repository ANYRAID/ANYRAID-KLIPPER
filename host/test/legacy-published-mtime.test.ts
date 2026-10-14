import {tmpdir} from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,open,utimes,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {PrintSnapshotBudget} from '../src/gcode/snapshot-budget.ts';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
const signal=()=>new AbortController().signal;
async function fixture(){const directory=await mkdtemp(join(tmpdir(),'legacy-published-')),source=join(directory,'original'),backing=join(directory,'published');await mkdir(source,{mode:0o755});const store=await PublishedPrintFiles.open(backing);return {directory,source,backing,store,async close(){await store.close();await rm(directory,{recursive:true,force:true});}};}
test('trusted publication preserves original model and Unicode/empty directory mtimes through a fresh store',async()=>{
 const f=await fixture();let sourceDirectory:Awaited<ReturnType<typeof open>>|undefined,file:typeof sourceDirectory,empty:typeof sourceDirectory,fresh:PublishedPrintFiles|undefined;
 try{const path=join(f.source,'中文😀'),model=join(path,'原模型.gco');await mkdir(path);await writeFile(model,'G1 X1\n');await utimes(model,1700000000.125,1700000000.125);await utimes(path,1600000000.25,1600000000.25);sourceDirectory=await open(path,'r');file=await open(model,'r');const sourceFileTime=(await file.stat()).mtimeMs/1000,sourceDirectoryTime=(await sourceDirectory.stat()).mtimeMs/1000;
  const emptyPath=join(f.source,'空目录');await mkdir(emptyPath,{mode:0o755});await utimes(emptyPath,sourceDirectoryTime,sourceDirectoryTime);empty=await open(emptyPath,'r');
  await f.store.importLegacyDirectory('中文😀',sourceDirectory,signal());await f.store.importLegacyFile('original-model','原模型.gco',file,signal(),'中文😀/原模型.gco');await f.store.importLegacyDirectory('空目录',empty,signal());assert(Math.abs((await f.store.describe('original-model',signal())).modified-sourceFileTime)<0.000001);assert.equal((await f.store.directoryCatalog('',signal())).directories.find(d=>d.path==='中文😀')!.modified,sourceDirectoryTime);
  await f.store.close();fresh=await PublishedPrintFiles.open(f.backing);assert(Math.abs((await fresh.describe('original-model',signal())).modified-sourceFileTime)<0.000001);assert.equal((await fresh.directoryCatalog('',signal())).directories.find(d=>d.path==='空目录')!.modified,sourceDirectoryTime);const budget=new PrintSnapshotBudget({maxSnapshots:1,maxBytes:65536}),binary=await fresh.acquireBinary('original-model',signal(),budget);try{const chunks:Buffer[]=[];for await(const chunk of binary.reader.chunks(signal()))chunks.push(chunk);assert.equal(Buffer.concat(chunks).toString(),'G1 X1\n');}finally{await binary.reader.close();}assert.equal(budget.status.reservations,0);
 }finally{await file?.close();await empty?.close();await sourceDirectory?.close();await fresh?.close();await f.close();}
});
test('directory import joins post-commit source identity validation before owner close completes',async t=>{
 const f=await fixture(),source=await open(f.source,'r'),entered=Promise.withResolvers<void>(),finish=Promise.withResolvers<void>();const original=source.stat.bind(source);let calls=0,closed=false;
 const mock=t.mock.method(source,'stat',async(options:any)=>{const result=await original(options);if(++calls===2){entered.resolve();await finish.promise;}return result;});
 try{const importing=f.store.importLegacyDirectory('original',source,signal());void importing.catch(()=>{});await entered.promise;const closing=f.store.close().then(()=>{closed=true;});await new Promise(r=>setImmediate(r));assert.equal(closed,false);finish.resolve();await importing;await closing;assert.equal(f.store.status.pendingOperations,0);}finally{finish.resolve();mock.mock.restore();await source.close();await f.close();}
});
