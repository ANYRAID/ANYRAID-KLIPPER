import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {managerFixture} from './helpers/motan-manager-fixture.ts';
import {analysisOracle,analysisNames} from './helpers/motan-analysis-oracle.ts';
test('analysis reference rejects changed captures and requests and cannot be mutated by callers',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'analysis-reference-')),prefix=join(dir,'log');
 try{
  await managerFixture(prefix);const original=analysisOracle(prefix,analysisNames,.01,.4),saved=structuredClone(original);
  original.times[0]=999;original.data[analysisNames[0]][0]=999;original.labels[analysisNames[0]].label='modified';
  assert.deepEqual(analysisOracle(prefix,analysisNames,.01,.4),saved);
  assert.throws(()=>analysisOracle(prefix,analysisNames,.02,.4),/Missing original/);
  assert.throws(()=>analysisOracle(prefix,[...analysisNames].reverse(),.01,.4),/Missing original/);
  const input=await readFile(prefix+'.json.gz');await writeFile(prefix+'.json.gz',Buffer.concat([input,Buffer.from([0])]));
  assert.throws(()=>analysisOracle(prefix,analysisNames,.01,.4),/Missing original/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
