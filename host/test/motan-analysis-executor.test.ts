import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,readlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {execFileSync} from 'node:child_process';
import {MotanAnalysisExecutor} from '../src/motan/analysis-executor.ts';
import {MotanAnalyzer} from '../src/motan/analyzer.ts';
import {MotanLogManager} from '../src/motan/log-manager.ts';
import {managerFixture} from './helpers/motan-manager-fixture.ts';

async function openDescriptors(prefix:string):Promise<string[]>{
 if(process.platform!=='linux')return [];
 const paths=await Promise.all((await readdir('/proc/self/fd')).map(async fd=>{
  try{return await readlink('/proc/self/fd/'+fd);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return '';throw error;}
 }));return paths.filter(path=>path.startsWith(prefix));
}

test('Motan worker owns request snapshots and transfers identical numerical results without Python',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-executor-')),prefix=join(dir,'log'),executor=new MotanAnalysisExecutor();
 try{await managerFixture(prefix);const datasets=['sos(accelerometer(a,x),filtfilt,bandpass,8,5,30)','derivative(trapq(toolhead,x))'];
  const manager=await MotanLogManager.open(prefix,{start:.5});let expected;
  try{const analyzer=new MotanAnalyzer(manager,.01);for(const name of datasets)analyzer.addDataset(name);expected=await analyzer.generate(.8);}
  finally{await manager.close();}
  const request={prefix,datasets:[...datasets],start:.5,segmentTime:.01,duration:.8};
  const pending=executor.analyze(request);request.datasets[0]='invalid';request.duration=50;
  assert.equal(executor.status.busy,true);await assert.rejects(executor.analyze({prefix,datasets}),/busy/);
  const result=await pending;assert.deepEqual(result,expected);
  assert.ok(Object.isFrozen(result.datasets));assert.ok(Object.isFrozen(result.labels[datasets[0]]));
  assert.equal(executor.status.busy,false);assert.deepEqual(await openDescriptors(prefix),[]);
  const runner=join(dir,'no-python.mts'),module=new URL('../src/motan/analysis-executor.ts',import.meta.url).href;
  await writeFile(runner,`import {MotanAnalysisExecutor} from ${JSON.stringify(module)};const e=new MotanAnalysisExecutor();try{const r=await e.analyze(${JSON.stringify({prefix,datasets:['trapq(toolhead,x)'],segmentTime:.01,duration:.1})});console.log(r.times.length);}finally{await e.close();}`);
  const out=execFileSync(process.execPath,[runner],{encoding:'utf8',timeout:10000,env:{...process.env,PATH:'/no-external-programs'}});
  assert.ok(Number(out.trim())>0);
 }finally{await executor.close();await rm(dir,{recursive:true,force:true});}
});

test('Motan worker cancellation and timeout terminate admission and release capture descriptors',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-executor-cancel-')),prefix=join(dir,'log'),executor=new MotanAnalysisExecutor();
 try{await managerFixture(prefix);const controller=new AbortController(),reason=new Error('user cancelled');
  const datasets=Array.from({length:80},(_,i)=>`sos(accelerometer(a,x),filtfilt,bandpass,64,${20+i*.1},${100+i*.1})`);
  let settled=false;const pending=executor.analyze({prefix,datasets,segmentTime:.001,duration:1},{signal:controller.signal}).then(
   result=>{settled=true;return result;},error=>{settled=true;return error;});
  const deadline=Date.now()+10000;let ticks=0;
  while(executor.status.phase!=='analyzing'&&!settled&&Date.now()<deadline){await delay(1);ticks++;}
  assert.equal(executor.status.phase,'analyzing');assert.ok(ticks>0);
  controller.abort(reason);assert.equal(executor.status.busy,true);
  await assert.rejects(executor.analyze({prefix,datasets:['trapq(toolhead,x)']}),/busy/);
  assert.equal(await pending,reason);assert.equal(executor.status.busy,false);
  assert.deepEqual(await openDescriptors(prefix),[]);
  await assert.rejects(executor.analyze({prefix,datasets,segmentTime:.001,duration:1},{timeoutMs:1}),/timed out/);
  assert.equal(executor.status.busy,false);assert.deepEqual(await openDescriptors(prefix),[]);
  assert.ok((await executor.analyze({prefix,datasets:['trapq(toolhead,x)'],segmentTime:.01,duration:.1})).times.length);
 }finally{await executor.close();await rm(dir,{recursive:true,force:true});}
});

test('Motan executor validates before launch, recovers from per-job failures and closes permanently',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-executor-owner-')),prefix=join(dir,'log'),executor=new MotanAnalysisExecutor();
 try{await managerFixture(prefix);const request={prefix,datasets:['trapq(toolhead,x)'],segmentTime:.01,duration:.1};
  for(const invalid of [{datasets:[]},{maxNumericBytes:0},{segmentTime:0},{duration:Infinity},{datasets:['x'.repeat(4097)]}])
   await assert.rejects(executor.analyze({...request,...invalid}),/request/);
  await assert.rejects(executor.analyze(request,{timeoutMs:0}),/timeout/);
  const controller=new AbortController(),reason=new Error('already cancelled');controller.abort(reason);
  await assert.rejects(executor.analyze(request,{signal:controller.signal}),error=>error===reason);
  assert.deepEqual(executor.status,{busy:false,closed:false,phase:'idle'});
  await assert.rejects(executor.analyze({...request,prefix:prefix+'-missing'}),/ENOENT/);
  assert.ok((await executor.analyze(request)).times.length);
  const pending=executor.analyze(request).catch(error=>error);
  await Promise.all([executor.close(),executor.close()]);assert.match(String(await pending),/closed/);
  assert.deepEqual(executor.status,{busy:false,closed:true,phase:'idle'});
  await assert.rejects(executor.analyze(request),/closed/);assert.deepEqual(await openDescriptors(prefix),[]);
 }finally{await executor.close();await rm(dir,{recursive:true,force:true});}
});
