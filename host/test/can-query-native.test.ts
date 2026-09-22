import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
// Separate process: no test transport can be loaded by the production CLI.
test('actual CAN Node-API implementation handles transport success, failures and finalization',()=>{
 const temporary=mkdtempSync(resolve(tmpdir(),'can-native-')),addon=resolve(temporary,'transport.node'),source=fileURLToPath(new URL('fixtures/can-query-transport.c',import.meta.url));
 try{
  const sanitizer=process.env.ANYRAID_CAN_QUERY_ADDON?.endsWith('-asan.node')?'address,undefined':process.env.ANYRAID_CAN_QUERY_ADDON?.endsWith('-ubsan.node')?'undefined':undefined;
  // LD_PRELOAD instruments the Node driver, not the compiler/linker processes.
  // Keep -fsanitize on the fixture and retain the original env for its execution.
  const compilerEnv={...process.env};if(sanitizer)delete compilerEnv.LD_PRELOAD;
  const compiled=spawnSync(process.env.CC??'cc',['-shared','-fPIC','-O2','-Wall','-Wextra','-Werror','-DNAPI_VERSION=8',`-I${process.env.NODE_INCLUDE??resolve(dirname(process.execPath),'../include/node')}`,source,...sanitizer?[`-fsanitize=${sanitizer}`,'-fno-sanitize-recover=all']:[],'-o',addon],{encoding:'utf8',timeout:60000,env:compilerEnv});assert.equal(compiled.status,0,compiled.stderr);
  const driver=String.raw`
const assert=require('node:assert/strict'),n=require(process.argv[1]);
(async()=>{
for(const mode of ['ok','eintr']){
 n.configure(mode);const h=n.open('mock0');assert.equal(n.stats().filters,1);assert.equal(n.stats().binds,1);
 n.sendQuery(h);assert.throws(()=>n.sendQuery(h),/already sent/);const r=n.read(h);assert.equal(r.id,0x3f1);assert.deepEqual([...r.data],[32,255,255,255,255,255,255,17]);assert.equal(n.read(h),null);
 n.close(h);n.close(h);assert.equal(n.stats().closed,1);assert.throws(()=>n.read(h),/closed/);assert.throws(()=>n.sendQuery(h),/closed/);assert.equal(n.stats().sends,mode==='ok'?1:2);
}
for(const mode of ['socket','filter','bind']){n.configure(mode);assert.throws(()=>n.open('mock0'));assert.equal(n.stats().opened,n.stats().closed);}
for(const mode of ['send','shortsend','read','shortread','oversizeread','badlen']){
 n.configure(mode);const h=n.open('mock0');try{if(mode.includes('send')){assert.throws(()=>n.sendQuery(h));assert.throws(()=>n.sendQuery(h),/already sent/);assert.equal(n.stats().sends,1);}else{n.sendQuery(h);assert.throws(()=>n.read(h));}}finally{n.close(h);}assert.equal(n.stats().closed,1);
}
n.configure('gc');(()=>{n.open('mock0');})();for(let i=0;i<100&&n.stats().closed===0;i++){global.gc();await new Promise(r=>setImmediate(r));}assert.equal(n.stats().closed,1,'finalizer must close unowned channel');
})().catch(e=>{console.error(e);process.exitCode=1;});`;
  const run=spawnSync(process.execPath,['--expose-gc','-e',driver,addon],{encoding:'utf8',timeout:20000});assert.equal(run.status,0,run.stderr||String(run.error||run.signal));
  const cli=spawnSync(process.execPath,[fileURLToPath(new URL('../../scripts/canbus_query.ts',import.meta.url)),'mock0'],{encoding:'utf8',timeout:10000,env:{...process.env,ANYRAID_CAN_QUERY_ADDON:addon}});
  assert.equal(cli.status,0,cli.stderr||String(cli.error||cli.signal));assert.equal(cli.stdout,'Found canbus_uuid=ffffffffffff, Application: CanBoot\nTotal 1 uuids found\n');
 }finally{rmSync(temporary,{recursive:true,force:true});}
});
