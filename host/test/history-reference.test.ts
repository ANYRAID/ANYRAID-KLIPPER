import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,copyFile,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {historyReference,historyReferenceInput,historyBenchmarkReference} from './helpers/history-reference.ts';

test('history references reject changed numeric inputs and preserve CPython signed zero',()=>{
 const input=historyReferenceInput('history-rounding'),cases=JSON.parse(input) as Array<[string,number]>;
 const output=historyReference<Array<[number,boolean]|'overflow'>>('history-rounding',input),index=cases.findIndex(([value,precision])=>value==='-0'&&precision===2);
 assert.ok(index>=0);const value=output[index];assert.notEqual(value,'overflow');assert.ok(Array.isArray(value));assert.ok(Object.is(value[0],-0));assert.equal(value[1],true);
 assert.throws(()=>historyReference('history-rounding',input+' '),/input changed/);
 const changed=JSON.parse(input);changed[index][1]=3;assert.throws(()=>historyReference('history-rounding',JSON.stringify(changed)),/input changed/);
});

test('historical benchmark rejects smaller loads independently of original empty stdin',async()=>{
 const inventory=JSON.parse(await readFile(new URL('../contracts/moonraker-history-reference-retirement.json',import.meta.url),'utf8'));
 for(const name of ['history-api-benchmark','history-repository-benchmark','history-tracker-benchmark'] as const){
  const capture=inventory.captures.find((value:any)=>value.name===name),original=historyBenchmarkReference(name,capture.workload);
  assert.equal(original.runtime,'CPython 3.12.13');assert.equal(original.capturedAt,capture.capturedAt);
  const workload=JSON.parse(capture.workload);workload.runs--;assert.throws(()=>historyBenchmarkReference(name,JSON.stringify(workload)),/workload changed/);
 }
});

async function isolated(run:(root:string,url:string)=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'history-reference-integrity-'));
 try{
  for(const folder of ['host/test/helpers','host/contracts'])await mkdir(join(root,folder),{recursive:true});
  for(const file of ['host/test/helpers/history-reference.ts','host/test/helpers/history-oracle.ts','host/contracts/moonraker-history-reference-retirement.json','host/contracts/moonraker-history.json'])await copyFile(new URL('../../'+file,import.meta.url),join(root,file));
  await run(root,pathToFileURL(join(root,'host/test/helpers/history-reference.ts')).href);
 }finally{await rm(root,{recursive:true,force:true});}
}

test('corrupt or missing inventory fails without generating a replacement reference',()=>isolated(async(root,url)=>{
 const file=join(root,'host/contracts/moonraker-history-reference-retirement.json'),original=await readFile(file);
 await writeFile(file,Buffer.concat([original,Buffer.from(' ')]));await assert.rejects(import(url+'?corrupt'),/inventory changed/);
 await rm(file);await assert.rejects(import(url+'?missing'),/ENOENT/);
}));

test('changed upstream or oracle provenance rejects fixed history output',()=>isolated(async(root,url)=>{
 const reader=await import(url),input=reader.historyReferenceInput('history-api');
 const file=join(root,'host/contracts/moonraker-history.json'),original=await readFile(file,'utf8'),upstream=JSON.parse(original);
 upstream.source+='\n';await writeFile(file,JSON.stringify(upstream));assert.throws(()=>reader.historyReference('history-api',input),/upstream source changed/);
 await writeFile(file,original);await writeFile(join(root,'host/test/helpers/history-oracle.ts'),'// changed capture harness\n');assert.throws(()=>reader.historyReference('history-api',input),/capture harness changed/);
}));
