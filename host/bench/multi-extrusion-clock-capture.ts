import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

// One fixed, bounded observation, preserving the original reverse=true test
// body and assertions. This is deliberately not a retry-until-pass driver.
const root=new URL('../../',import.meta.url),originalPath=new URL('host/test/multi-extrusion-printer.test.ts',root);
const original=await readFile(originalPath,'utf8'),digest=(text:string|Buffer)=>createHash('sha256').update(text).digest('hex');
let source=original.replace(/from '(\.\/helpers\/[^']+|\.\.\/src\/[^']+)'/g,(_,path)=>'from '+JSON.stringify(new URL(path,originalPath).href));
source=`import {captureClockFaults} from ${JSON.stringify(new URL('host/test/helpers/clock-fault-diagnostic.ts',root).href)};\n`+source;
const replaceOnce=(before:string,after:string)=>{assert.equal(source.split(before).length,2,'Original fixture marker must be unique');source=source.replace(before,after);};
replaceOnce('async()=>{\n const f=await configuredPrinterFixture(reverse);',`async t=>{\n const capture=captureClockFaults(t.mock,serialClock.now,row=>process.stderr.write('clockRetirement='+JSON.stringify(row,(_,v)=>typeof v==='bigint'?String(v):v)+'\\n'));\n const f=await configuredPrinterFixture(reverse,false);`);
replaceOnce(' try{\n  const original=',` const injected:{name:string;requestedMs:number;actualMs:number;beforeClock:number;afterClock:number}[]=[],waiter=new Int32Array(new SharedArrayBuffer(4));let uptimeSeen=false,clockSeen=0;
 const unobserve=f.firmware[1].observeCommands(cmd=>{
  const ms=cmd.name==='get_uptime'&&!uptimeSeen?(uptimeSeen=true,4):cmd.name==='get_clock'&&clockSeen++<2?20:0;
  if(!ms)return;const before=performance.now(),beforeClock=f.firmware[1].currentClock();Atomics.wait(waiter,0,0,ms);injected.push({name:cmd.name,requestedMs:ms,actualMs:performance.now()-before,beforeClock,afterClock:f.firmware[1].currentClock()});
 });
 try{
  await f.group.start(f.signal);for(const [id,c] of f.clocks)c.currentPrintTime=Number(f.group.session(id).clock.sync.getClock(serialClock.now()))/1e6;
  const original=`);
replaceOnce(' }finally{if(timer)clearInterval(timer);await hardware?.close();await f.close();}',` }catch(error){t.diagnostic('fixtureError='+JSON.stringify({name:(error as Error).name,message:(error as Error).message}));throw error;
 }finally{
  t.diagnostic('clockRetirementsBeforeCleanup='+JSON.stringify(capture.snapshot(),(_,v)=>typeof v==='bigint'?String(v):v));
  t.diagnostic('injectedClockDelays='+JSON.stringify(injected));t.diagnostic('physicalStopsBeforeCleanup='+JSON.stringify(f.stops));
  unobserve();if(timer)clearInterval(timer);await hardware?.close();await f.close();
 }`);
const dir=await mkdtemp(join(process.env.TMPDIR??tmpdir(),'anyraid-multi-clock-')),driver=join(dir,'driver.test.ts');
await writeFile(driver,source);
const result=spawnSync(process.execPath,['--test','--test-isolation=none','--test-name-pattern=reverse=true',driver],{encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024,env:process.env});
await writeFile(join(dir,'stdout.log'),result.stdout??'');await writeFile(join(dir,'stderr.log'),result.stderr??'');
const metadata={schema:1,originalSourceSha256:digest(original),driverSha256:digest(source),node:process.version,timeoutMs:60000,status:result.status,signal:result.signal,error:result.error?{name:result.error.name,message:result.error.message}:null,stdoutSha256:digest(result.stdout??''),stderrSha256:digest(result.stderr??''),changes:['Absolute imports','Original autostart deferred until same group.start, then same clock initialization','Aux accepted-command delays 4/20/20 ms before model clock read','First-retirement observer, original single-invocation operands and failure-only snapshots','Original reverse=true name filter'],scope:'Controlled input differs from the original CI run. Original body, assertions, warmup algorithm, query deadlines, lease, motion precision and production classes are unchanged. No real printer or client acceptance.'};
await writeFile(join(dir,'result.json'),JSON.stringify(metadata,null,2)+'\n');console.log(JSON.stringify({directory:dir,...metadata},null,2));
// Propagate the actual fixture outcome. Expected failures remain failures.
process.exitCode=result.status??1;
