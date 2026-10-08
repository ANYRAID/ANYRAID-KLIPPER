import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const reporter=fileURLToPath(new URL('../scripts/test-failure-reporter.mjs',import.meta.url));
async function observe(body:string){
 const directory=await mkdtemp(join(tmpdir(),'test-exit-observation-'));
 try{
  const fixture=join(directory,'fixture.test.mjs');await writeFile(fixture,body);
  // This is a separate test runner, not a worker of the parent test runner.
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const result=spawnSync(process.execPath,['--test','--test-reporter=spec','--test-reporter='+reporter,'--test-reporter-destination=stdout','--test-reporter-destination=stdout',fixture],{env,encoding:'utf8',timeout:10000,maxBuffer:128*1024});
  assert.equal(result.error,undefined);assert.equal(result.signal,null);
  const rows=result.stdout.split('\n').filter(line=>line.startsWith('{"nodeTest')).map(line=>JSON.parse(line));
  const summary=rows.filter(row=>row.nodeTestObservation);assert.equal(summary.length,1);
  return {result,failures:rows.filter(row=>row.nodeTestFailure).map(row=>row.nodeTestFailure),summary:summary[0].nodeTestObservation};
 }finally{await rm(directory,{recursive:true,force:true});}
}
test('ordinary reporter retains a killed file signal and the failing runner exit',async()=>{
 const {result,failures,summary}=await observe("process.kill(process.pid,'SIGKILL');");
 assert.equal(result.status,1);assert.equal(failures.length,1);
 assert.equal(failures[0].error.signal,'SIGKILL');assert.equal(failures[0].error.exitCode,null);
 assert.equal(failures[0].error.failureType,'testCodeFailure');assert.equal(summary.success,false);
 assert.equal(summary.counts.failed,1);assert.match(result.stdout,/test failed/);
});
test('ordinary reporter distinguishes an explicit exit from a missing signal',async()=>{
 const {result,failures,summary}=await observe('process.exit(17);');
 assert.equal(result.status,1);assert.equal(failures.length,1);
 assert.equal(failures[0].error.exitCode,17);assert.equal(failures[0].error.signal,null);
 assert.equal(summary.success,false);assert.equal(summary.counts.failed,1);
});
test('ordinary reporter identifies assertion failures without copying arbitrary error values',async()=>{
 const {result,failures}=await observe("import{test}from'node:test';import assert from'node:assert/strict';test('assertion',()=>assert.equal('sensitive-actual','sensitive-expected'));");
 assert.equal(result.status,1);assert.equal(failures.length,1);
 assert.equal(failures[0].error.causeCode,'ERR_ASSERTION');assert.equal(failures[0].error.signal,null);
 assert(!JSON.stringify(failures).includes('sensitive-'));assert.equal(failures[0].error.exitCode,null);
});
test('ordinary reporter preserves successful tests and emits no failure records',async()=>{
 const {result,failures,summary}=await observe("import{test}from'node:test';test('successful',()=>{});");
 assert.equal(result.status,0);assert.equal(failures.length,0);
 assert.equal(summary.success,true);assert.equal(summary.counts.tests,1);assert.equal(summary.counts.passed,1);
});
test('ordinary reporter bounds failure labels and preserves unknown metadata as null',async()=>{
 const {default:report}=await import(new URL('../scripts/test-failure-reporter.mjs',import.meta.url).href);
 async function* events(){yield {type:'test:fail',data:{name:'\u0000'.repeat(100000),details:{error:{message:'do-not-copy',cause:{secret:'do-not-copy'}}}}};}
 const lines:string[]=[];for await(const line of report(events()))lines.push(line);
 assert.equal(lines.length,1);assert(Buffer.byteLength(lines[0])<16384);
 const row=JSON.parse(lines[0]).nodeTestFailure;assert.deepEqual(row.truncatedFields,['name']);
 assert.equal(row.file,null);assert.equal(row.error.signal,null);assert.equal(row.error.exitCode,null);
 assert(!lines[0].includes('do-not-copy'));
});
