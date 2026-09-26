import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,symlink,mkdir,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {validateMotanOutput} from '../src/motan/output-path.ts';
import {managerFixture} from './helpers/motan-manager-fixture.ts';
const cli=new URL('../../scripts/motan/data_export.ts',import.meta.url).pathname;
test('CSV CLI rejects capture and index destinations through normalized and aliased directories before analysis',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-output-')),prefix=join(dir,'log');
 try{
  await managerFixture(prefix);await symlink(dir,join(dir,'alias'),'dir');await mkdir(join(dir,'nested'));
  const files=['.json.gz','.index.gz'],before=await Promise.all(files.map(s=>readFile(prefix+s)));
  for(const suffix of files)for(const output of [prefix+suffix,join(dir,'nested','..','log'+suffix),join(dir,'alias','log'+suffix)]){
   const result=spawnSync(process.execPath,[cli,prefix,'-c',"['invalid-before-analysis']",'-o',output],{encoding:'utf8',env:{...process.env,PATH:'/no-programs'},timeout:10000});
   assert.equal(result.error,undefined);assert.equal(result.status,1);assert.match(result.stderr,/Output must not replace a Motan capture/);assert.equal(result.stdout,'');
  }
  for(let i=0;i<files.length;i++)assert.deepEqual(await readFile(prefix+files[i]),before[i]);
  assert.ok(!(await readdir(dir)).some(name=>name.endsWith('.tmp')));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('new export paths and final symlink entries remain usable with atomic replacement',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-output-')),prefix=join(dir,'log'),output=join(dir,'out.csv');
 try{
  await managerFixture(prefix);const source=await readFile(prefix+'.json.gz');
  await validateMotanOutput(prefix,output);await symlink(prefix+'.json.gz',output);
  const result=spawnSync(process.execPath,[cli,prefix,'-c',"['status(heater.temperature)']",'-d','.02','--segment-time','.01','-o',output],{encoding:'utf8',env:{...process.env,PATH:'/no-programs'},timeout:10000});
  assert.equal(result.status,0,result.stderr);assert.match(await readFile(output,'utf8'),/^Time \(s\),/);assert.deepEqual(await readFile(prefix+'.json.gz'),source);
  await writeFile(output,'keep');await assert.rejects(validateMotanOutput(prefix,join(dir,'missing','out.csv')),/ENOENT/);assert.equal(await readFile(output,'utf8'),'keep');
 }finally{await rm(dir,{recursive:true,force:true});}
});
