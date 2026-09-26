import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {motanCsvReference} from './helpers/motan-csv-reference.ts';
import {listMotanDatasets,formatMotanDatasets} from '../src/motan/dataset-catalog.ts';
const root=fileURLToPath(new URL('../../',import.meta.url)),cli=join(root,'scripts/motan/data_export.ts');
test('Motan syntax catalog matches Python handler ordering, aliases, descriptions and output bytes',()=>{
 const expected=motanCsvReference().catalog;
 assert.equal(formatMotanDatasets(),expected);
 const entries=listMotanDatasets();assert.equal(entries.length,36);assert.deepEqual(entries[0],entries[1]);
 assert.equal(Object.isFrozen(entries),true);assert.ok(entries.every(Object.isFrozen));
 assert.throws(()=>Object.assign(entries[0],{0:'changed'}),TypeError);
 assert.equal(formatMotanDatasets(),expected);
});
test('dataset listing needs no log, columns, Python, or output write and preserves normal option errors',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-catalog-')),output=join(dir,'keep.csv'),env={...process.env,PATH:'/no-external-programs'};
 try{
  await writeFile(output,'keep');
  for(const args of [['-l'],['--list-datasets','missing','-c','not a literal','-o',output],['-l','missing','extra']]){
   const result=execFileSync(process.execPath,[cli,...args],{encoding:'utf8',env,cwd:dir,timeout:10000});
   assert.equal(result,motanCsvReference().catalog);
  }
  assert.equal(await readFile(output,'utf8'),'keep');assert.deepEqual(await readdir(dir),['keep.csv']);
  assert.match(execFileSync(process.execPath,[cli,'--help'],{encoding:'utf8',env}),/--list-datasets/);
  for(const args of [['-l','--unknown'],['-l','-o'],['-l','--list-datasets=bad'],['-l','-s','bad'],['-l','-d','bad'],['-l','--segment-time','bad']])assert.throws(()=>execFileSync(process.execPath,[cli,...args],{env,stdio:'pipe',timeout:10000}));
 }finally{await rm(dir,{recursive:true,force:true});}
});
