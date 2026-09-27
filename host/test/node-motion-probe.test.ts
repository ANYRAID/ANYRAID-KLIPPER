import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,rmSync,mkdtempSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {deserialize} from 'node:v8';
const cli=fileURLToPath(new URL('../scripts/diagnose-node-asan.ts',import.meta.url));
test('compiled probe also freezes a complete source control for runtime comparisons',()=>{
 const run=spawnSync(process.execPath,[cli,'--case','motion','--asan','off','--execution','compiled','--runs','1','--workers','1'],{encoding:'utf8',timeout:30000,maxBuffer:1024**2});
 const first=run.stdout.split('\n').find(line=>line.startsWith('{'));assert(first,run.stderr);const {directory}=JSON.parse(first);
 try{
  assert.equal(run.status,0,run.stderr+run.stdout);const report=JSON.parse(readFileSync(join(directory,'report.json'),'utf8'));assert.equal(report.state,'completed');
  assert(report.compiledHashes['src/diagnostics/graphstats.js']);assert(report.frozenSourceHashes['src/diagnostics/graphstats.ts']);assert(report.compiledHashes['contracts/motion-retirement.json']);assert(report.frozenSourceHashes['contracts/motion-retirement.json']);
  assert.equal(report.sourceFixture.sha256,createHash('sha256').update(readFileSync(report.sourceFixture.path)).digest('hex'));
  const source=spawnSync(process.execPath,['--experimental-strip-types',report.sourceFixture.path],{encoding:'utf8',timeout:15000});assert.equal(source.status,0,source.stderr);assert.equal(source.stdout,'motion:loading\nmotion:loaded\nmotion:verified\n');
 }finally{rmSync(directory,{recursive:true,force:true});}
});
test('motion runtime probe verifies original reference in bounded fresh Node children and records source hashes',()=>{
 const run=spawnSync(process.execPath,[cli,'--case','motion','--asan','off','--runs','2','--workers','1'],{encoding:'utf8',timeout:30000,maxBuffer:1024**2,env:{...process.env,CC:'/nonexistent-compiler'}});
 const first=run.stdout.split('\n').find(line=>line.startsWith('{'));assert.ok(first,run.stderr);const {directory}=JSON.parse(first);
 try{assert.equal(run.status,0,run.stderr+'\n'+run.stdout);const report=JSON.parse(readFileSync(join(directory,'report.json'),'utf8'));assert.equal(report.kind,'motion');assert.equal(report.asan,'off');assert.deepEqual(report.addonHashes,{});assert.equal(report.results.length,2);assert.equal(report.state,'completed');assert.deepEqual(report.active,[]);
 assert.equal(report.jsOptimization,'default');assert.equal(report.runtime,undefined);assert.equal(report.runtimeSha256,undefined);assert.equal(report.args.length,1);assert.equal(report.childWorkingDirectory,directory);assert.deepEqual(report.coreFiles,[]);if(process.platform==='linux'){assert.match(report.corePolicy.limits,/Max core file size/);assert.match(report.corePolicy.filter,/^[0-9a-f]+$/);}
 for(const result of report.results){assert.equal(result.status,0);assert.equal(result.signal,null);assert.equal(result.stdout,'motion:loading\nmotion:loaded\nmotion:verified\n');}
 const source=readFileSync(new URL('../src/diagnostics/graph-motion.ts',import.meta.url));assert.equal(report.moduleHashes['src/diagnostics/graph-motion.ts'],createHash('sha256').update(source).digest('hex'));assert.equal(report.fixtureSha256,createHash('sha256').update(readFileSync(join(directory,'fixture.mjs'))).digest('hex'));
 const fixture=readFileSync(join(directory,'fixture.mjs'),'utf8'),injected=fixture.replace('const expected=r.curves[j];','const expected=r.curves[j];if(run===0&&i===0&&j===0)c.values[0]+=1;');assert.notEqual(fixture,injected);const path=join(directory,'injected.mjs');writeFileSync(path,injected);
 const failure=spawnSync(process.execPath,[path],{encoding:'utf8',timeout:10000});assert.equal(failure.status,1);assert.match(failure.stderr,/Error: Motion numerical mismatch /);const line=failure.stderr.split('\n').find(l=>l.startsWith('Error: Motion numerical mismatch '))!;const detail=JSON.parse(line.slice('Error: Motion numerical mismatch '.length));assert.equal(detail.actual,1);assert.equal(detail.expected,0);assert.equal(detail.repeated,0);assert.equal(detail.xor,'0x3ff0000000000000');assert.doesNotMatch(failure.stdout,/motion:verified/);
 const captured=deserialize(readFileSync(new URL(detail.capture))),repeated=deserialize(readFileSync(new URL(detail.capture+'.repeat')));
 assert.equal(captured.version,3);assert.deepEqual(captured.comparison,{actual:1,expected:0,difference:1,absolute:1,within:false,tolerance:1e-8});assert.deepEqual(captured.stages.nominal,captured.positions);assert.equal(captured.stages.velocity[0][0],0);assert.equal(captured.stages.acceleration.length,4);assert.equal(captured.panels[0].plot.curves[0].values[0],1);assert.equal(captured.reference.panels[0].curves[0].values[0],0);assert.equal(repeated.panels[0].plot.curves[0].values[0],0);
 const positionPath=join(directory,'position-injected.mjs');writeFileSync(positionPath,fixture.replace('assert.equal(positions.length,reference.positions.length);','if(run===0)positions[0]+=1;assert.equal(positions.length,reference.positions.length);'));
 const positionFailure=spawnSync(process.execPath,[positionPath],{encoding:'utf8',timeout:10000});assert.equal(positionFailure.status,1);const positionLine=positionFailure.stderr.split('\n').find(l=>l.startsWith('Error: Motion position mismatch '))!;assert(positionLine);const positionDetail=JSON.parse(positionLine.slice('Error: Motion position mismatch '.length));assert.equal(positionDetail.actual,1);assert.equal(positionDetail.expected,0);assert.equal(positionDetail.repeated,0);const positionCapture=deserialize(readFileSync(new URL(positionDetail.capture)));assert.equal(positionCapture.kind,'positions');assert.equal(positionCapture.comparison.difference,1);assert.equal(positionCapture.comparison.within,false);assert.equal(positionCapture.positions[0],1);
 assert.deepEqual(captured.positions,repeated.positions);assert(captured.positions.length>1000);assert.equal(captured.panels.length,3);assert.deepEqual(report.mismatchFiles,[]);

 }finally{rmSync(directory,{recursive:true,force:true});}
});
test('probe records explicit optimizing compiler controls without requiring a C compiler',()=>{
 const run=spawnSync(process.execPath,[cli,'--case','motion','--asan','off','--js-optimization','off','--runs','1','--workers','1'],{encoding:'utf8',timeout:30000,maxBuffer:1024**2,env:{...process.env,CC:'/nonexistent-compiler'}});
 const first=run.stdout.split('\n').find(line=>line.startsWith('{'));assert.ok(first,run.stderr);const {directory}=JSON.parse(first);
 try{assert.equal(run.status,0,run.stderr+'\n'+run.stdout);const report=JSON.parse(readFileSync(join(directory,'report.json'),'utf8'));assert.equal(report.jsOptimization,'off');assert.deepEqual(report.args.slice(0,2),['--no-maglev','--no-turbofan']);assert.equal(report.runtime,undefined);assert.equal(report.results[0].stdout,'motion:loading\nmotion:loaded\nmotion:verified\n');}finally{rmSync(directory,{recursive:true,force:true});}
});
test('probe preserves artifacts in an owned child directory and rejects silent successful exit',()=>{
 const parent=mkdtempSync(join(tmpdir(),'motion-ci-test-')),fake=join(parent,'silent-node');
 try{writeFileSync(join(parent,'sentinel'),'preserve');writeFileSync(fake,'#!'+process.execPath+'\nif(process.argv.includes("--version"))console.log(process.version);else require("node:fs").writeFileSync("core.fixture","test");\n');chmodSync(fake,0o700);
 const run=spawnSync(process.execPath,[cli,'--node',fake,'--case','motion','--asan','off','--runs','3','--workers','1','--report-parent',parent],{encoding:'utf8',timeout:30000,maxBuffer:1024**2});assert.equal(run.status,1,run.stdout+run.stderr);const {directory}=JSON.parse(run.stdout.split('\n')[0]);assert.equal(directory.startsWith(join(parent,'anyraid-node-asan-')),true);assert.equal(readFileSync(join(parent,'sentinel'),'utf8'),'preserve');const report=JSON.parse(readFileSync(join(directory,'report.json'),'utf8'));assert.equal(report.results.length,1);assert.equal(report.state,'failed');assert.deepEqual(report.active,[]);assert.equal(report.childWorkingDirectory,directory);assert.deepEqual(report.coreFiles,[{path:join(directory,'core.fixture'),bytes:4}]);assert.equal(report.results[0].status,0);assert.equal(report.results[0].error,'Verification completion marker missing');assert.ok(readFileSync(join(directory,'fixture.mjs'),'utf8').includes('motion:verified'));
 }finally{rmSync(parent,{recursive:true,force:true});}
});
test('probe rejects unbounded workers or runs before launching workloads',()=>{for(const args of [['--runs','1001'],['--workers','9'],['--js-optimization','unknown'],['--report-parent','relative']]){const result=spawnSync(process.execPath,[cli,'--case','motion',...args],{encoding:'utf8',timeout:10000});assert.equal(result.status,1);assert.match(result.stderr,/Invalid diagnostic options/);assert.equal(result.stdout,'');}});

for(const signal of ['SIGTERM','SIGKILL'] as const)test(`probe checkpoints completed children before parent ${signal}`,async()=>{
 const {spawn}=await import('node:child_process'),{setTimeout:delay}=await import('node:timers/promises');
 const parent=mkdtempSync(join(tmpdir(),'motion-checkpoint-')),fake=join(parent,'controlled-node');let child:ReturnType<typeof spawn>|undefined,worker:number|undefined;
 try{
  writeFileSync(fake,'#!'+process.execPath+`\nconst fs=require('node:fs');
if(process.argv.includes('--version'))console.log(process.version);
else if(!fs.existsSync('first-completed')){fs.writeFileSync('first-completed','yes');console.log('started');}
else {setTimeout(()=>process.exit(2),15000);}
`);chmodSync(fake,0o700);
  child=spawn(process.execPath,[cli,'--node',fake,'--case','empty','--asan','off','--runs','3','--workers','1','--report-parent',parent],{stdio:['ignore','pipe','pipe']});
  let output='',stderr='';child.stdout!.on('data',b=>{output+=b;});child.stderr!.on('data',b=>{stderr+=b;});
  const ended=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child!.once('error',reject);child!.once('close',(code,signal)=>resolve({code,signal}));});
  let directory:string|undefined,checkpoint:any;const deadline=performance.now()+10000;
  for(;;){
   assert(child.exitCode===null&&child.signalCode===null,output+stderr);assert(performance.now()<deadline,'Missing incremental checkpoint: '+output+stderr);
   const line=output.split('\n').find(l=>l.startsWith('{')&&l.endsWith('}'));if(line)directory=JSON.parse(line).directory;
   if(directory){checkpoint=JSON.parse(readFileSync(join(directory,'report.json'),'utf8'));if(checkpoint.results.length===1&&checkpoint.active.length===1)break;}
   await delay(10);
  }
  assert.equal(checkpoint.state,'running');assert.equal(checkpoint.results[0].stdout,'started\n');assert.equal(checkpoint.results[0].status,0);assert.equal(checkpoint.active[0].index,1);worker=checkpoint.active[0].pid;assert.equal(typeof worker,'number');
  assert.equal(child.kill(signal),true);const result=await ended;
  const report=JSON.parse(readFileSync(join(directory!,'report.json'),'utf8'));
  if(signal==='SIGTERM'){
   assert.equal(result.code,143);assert.equal(report.state,'interrupted');assert.equal(report.interruption,'SIGTERM');assert.deepEqual(report.active,[]);assert.equal(report.results.length,2);assert.equal(report.results[1].signal,'SIGTERM');assert.equal(report.results[1].status,null);
  }else{
   assert.equal(result.signal,'SIGKILL');assert.equal(report.state,'running');assert.equal(report.results.length,1);assert.equal(report.active[0].pid,worker);
  }
  assert.equal(report.limit,3);assert.equal(report.results[0].stdout,'started\n');assert(report.elapsedMs>=0);assert.equal(report.startedAt,checkpoint.startedAt);
 }finally{
  if(child?.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
  if(worker)try{process.kill(worker,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
  rmSync(parent,{recursive:true,force:true});
 }
});
