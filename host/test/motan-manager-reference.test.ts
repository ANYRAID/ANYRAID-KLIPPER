import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {managerFixture,managerDatasets} from './helpers/motan-manager-fixture.ts';
import {managerOracle} from './helpers/motan-manager-oracle.ts';
test('manager reference preserves independent snapshots and rejects altered times, seek and index',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'manager-reference-')),prefix=join(dir,'capture'),times=[10.75,11.25,12.75,13.25,14];
 try{
  await managerFixture(prefix);const first=managerOracle(prefix,0,managerDatasets,times),expected=structuredClone(first);
  first.values[0][managerDatasets[0]]=999;first.labels[managerDatasets[0]].label='modified';
  assert.deepEqual(managerOracle(prefix,0,managerDatasets,times),expected);
  assert.throws(()=>managerOracle(prefix,1,managerDatasets,times),/Missing original/);
  assert.throws(()=>managerOracle(prefix,0,managerDatasets,[...times,14.5]),/Missing original/);
  const index=await readFile(prefix+'.index.gz');await writeFile(prefix+'.index.gz',Buffer.concat([index,Buffer.from([0])]));
  assert.throws(()=>managerOracle(prefix,0,managerDatasets,times),/Missing original/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
