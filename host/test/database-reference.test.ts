import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,mkdir,mkdtemp,copyFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {databaseReference,databaseBenchmarkReference} from './helpers/database-reference.ts';

test('database reference inputs cannot silently become a different oracle workload',async()=>{
 const capsule=JSON.parse(await readFile(new URL('../contracts/database-python-retirement-reference.json',import.meta.url),'utf8'));
 for(const capture of capsule.captures){
  assert.deepEqual(databaseReference(capture.name,capture.input),JSON.parse(capture.output));
  assert.throws(()=>databaseReference(capture.name,capture.input+' '),/input changed/);
 }
 assert.throws(()=>databaseReference('unrecorded-case','{}'),/Missing original/);
});

test('uncaptured benchmark configurations retain Node measurement without fabricating historical timings',async()=>{
 const capsule=JSON.parse(await readFile(new URL('../contracts/database-python-retirement-reference.json',import.meta.url),'utf8'));
 for(const capture of capsule.benchmarks){
  const original=databaseBenchmarkReference(capture.name,capture.workload);assert.ok(original);
  assert.equal(original.capturedAt,capture.capturedAt);assert.deepEqual(original.samplesMs,JSON.parse(capture.output));
  assert.equal(databaseBenchmarkReference(capture.name,capture.workload+' '),null);
 }
 assert.equal(databaseBenchmarkReference('database','{}'),null);
});

for(const modified of ['reference-output','upstream-source'] as const)test('isolated database reference rejects tampered '+modified,async()=>{
 const root=await mkdtemp(join(tmpdir(),'database-reference-integrity-'));
 try{
  for(const path of ['test/helpers','contracts'])await mkdir(join(root,path),{recursive:true});
  for(const path of ['test/helpers/database-reference.ts','contracts/database-python-retirement-reference.json','contracts/moonraker-database.json'])await copyFile(new URL('../'+path,import.meta.url),join(root,path));
  const file=join(root,'contracts',modified==='reference-output'?'database-python-retirement-reference.json':'moonraker-database.json');
  const contents=JSON.parse(await readFile(file,'utf8'));
  if(modified==='reference-output'){contents.captures[0].output='[]';contents.captures[0].outputSha256=createHash('sha256').update(contents.captures[0].output).digest('hex');}else contents.source+='\n# altered source';
  await writeFile(file,JSON.stringify(contents));
  await assert.rejects(import(pathToFileURL(join(root,'test/helpers/database-reference.ts')).href),modified==='reference-output'?/capsule changed/:/upstream source changed/);
 }finally{await rm(root,{recursive:true,force:true});}
});
