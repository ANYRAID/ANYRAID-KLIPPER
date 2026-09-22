import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {buildMotan} from '../scripts/build-motan.ts';
import {managerFixture} from './helpers/motan-manager-fixture.ts';
import {parseTypedMotanJson} from '../src/motan/number-types.ts';
const root=fileURLToPath(new URL('../../',import.meta.url)),build=join(root,'host/build');

test('compiled Motan CLI and worker run without TypeScript or Python and retain structured/numeric/filtered output',async()=>{
 await mkdir(build,{recursive:true});const dir=await mkdtemp(join(build,'.motan-test-')),output=join(dir,'app'),prefix=join(dir,'log');
 try{
  await buildMotan(output);
  const marker=JSON.parse(await readFile(join(output,'build-info.json'),'utf8'));assert.equal(marker.schema,1);assert.equal(marker.node,process.version);
  for(const [path,hash]of Object.entries(marker.files))assert.equal(createHash('sha256').update(await readFile(join(output,path))).digest('hex'),hash,path);
  assert.ok(marker.files['host/licenses/scipy-signal.txt']);assert.ok(marker.files['COPYING']);assert.ok(marker.files['host/contracts/unicode-lower-15.json']);
  assert.equal(JSON.parse(await readFile(join(output,'package.json'),'utf8')).dependencies['complex.js'],'2.4.3');
  await managerFixture(prefix,2,'corexy',parseTypedMotanJson('{"value":{"2":[1,1.0,-0.0,9007199254740993],"1":"雪"},"signal":3}') as Record<string,unknown>);
  const columns=['status(export_fields.value)','step_phase(tmc2209 stepper_x)','derivative(trapq(toolhead,x))','sos(status(export_fields.signal),filtfilt,lowpass,2,10)'];
  const env={...process.env,PATH:'/no-programs',NODE_DISABLE_COMPILE_CACHE:'1'},cli=join(output,'scripts/motan/data_export.js');
  for(const options of [['--list-datasets'],['--help'],[prefix,'-c',JSON.stringify(columns),'--preserve-number-types','-d','.5','--segment-time','.01'],[prefix,'-c','["trapq(toolhead,x)"]','-d','0']]){
   const compiled=execFileSync(process.execPath,['--no-experimental-strip-types',cli,...options],{encoding:'utf8',env,timeout:15000});
   const source=execFileSync(process.execPath,[join(root,'scripts/motan/data_export.ts'),...options],{encoding:'utf8',env,timeout:15000});assert.equal(compiled,source);
  }
  const harness=join(dir,'lifecycle.mjs');
  await writeFile(harness,`import assert from 'node:assert/strict';
import {MotanAnalysisExecutor} from ${JSON.stringify(pathToFileURL(join(output,'host/src/motan/analysis-executor.js')).href)};
const owner=new MotanAnalysisExecutor(),request={prefix:${JSON.stringify(prefix)},datasets:['trapq(toolhead,x)'],duration:.1,segmentTime:.01};
await assert.rejects(owner.analyze(request,{timeoutMs:1}),/timed out/);
assert.equal(owner.status.busy,false);
const controller=new AbortController(),pending=owner.analyze(request,{signal:controller.signal});controller.abort(new Error('stop compiled job'));await assert.rejects(pending,/stop compiled job/);
const valid=await owner.analyze(request);assert.ok(valid.times.length>0);
const closing=owner.analyze(request),rejected=assert.rejects(closing,/closed/);await owner.close();await rejected;assert.equal(owner.status.busy,false);
console.log('exact');`);
  assert.equal(execFileSync(process.execPath,['--no-experimental-strip-types',harness],{encoding:'utf8',env,timeout:15000}).trim(),'exact');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('Motan builds are reproducible, preserve the last build on failure and refuse unowned or locked destinations',async()=>{
 await mkdir(build,{recursive:true});const dir=await mkdtemp(join(build,'.motan-publish-test-')),output=join(dir,'app');
 try{
  await buildMotan(output);const previous=await readFile(join(output,'build-info.json'),'utf8');await buildMotan(output);assert.equal(await readFile(join(output,'build-info.json'),'utf8'),previous);
  const bad=join(dir,'bad.ts'),config=join(dir,'bad.json');await writeFile(bad,'const value: number = "not a number";\n');await writeFile(config,JSON.stringify({extends:join(root,'host/tsconfig.motan.json'),include:[bad]}));
  await assert.rejects(buildMotan(output,config),/TypeScript build failed/);assert.equal(await readFile(join(output,'build-info.json'),'utf8'),previous);
  assert.ok(!(await readdir(dir)).some(name=>name.endsWith('.lock')||name.startsWith('.motan-build-')));
  await mkdir(output+'.lock');await assert.rejects(buildMotan(output),/locked/);await rm(output+'.lock',{recursive:true});
  const unowned=join(dir,'user-files');await mkdir(unowned);await writeFile(join(unowned,'keep'),'unchanged');await assert.rejects(buildMotan(unowned),/unrecognized/);assert.equal(await readFile(join(unowned,'keep'),'utf8'),'unchanged');
 }finally{await rm(dir,{recursive:true,force:true});}
});
