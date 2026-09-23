import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
test('reactor and concurrent enqueue races cannot stamp a new request in the past',()=>{
 const root=fileURLToPath(new URL('../../',import.meta.url)),helper=join(root,'klippy/chelper'),dir=mkdtempSync(join(tmpdir(),'serial-clock-'));
 try{
  const executable=join(dir,'check'),addon=process.env.ANYRAID_SERIALQUEUE_ADDON??'',sanitizer=addon.endsWith('-asan.node')?'address,undefined':addon.endsWith('-ubsan.node')?'undefined':undefined;
  const env={...process.env};delete env.LD_PRELOAD;
  // Linux ASan PIE startup can fail before main on this host.
  // Keep both sanitizers; only the standalone regression executable is non-PIE.
  const link=sanitizer==='address,undefined'&&process.platform==='linux'?['-no-pie']:[];
  const build=spawnSync(process.env.CC??'cc',['-O2',`-I${helper}`,`-DSERIALQUEUE_SOURCE=${JSON.stringify(join(helper,'serialqueue.c'))}`,join(root,'host/test/helpers/serial-clock-provenance.c'),...['msgblock.c','pyhelper.c','pollreactor.c'].map(p=>join(helper,p)),'-lm','-pthread',...link,...sanitizer?[`-fsanitize=${sanitizer}`,'-fno-sanitize-recover=all']:[],'-o',executable],{env,encoding:'utf8',timeout:30000});
  assert.equal(build.status,0,build.stderr);// The C executable links its sanitizer runtime; Node's preload is not needed.
  const check=spawnSync(executable,[],{env,encoding:'utf8',timeout:5000});assert.equal(check.status,0,check.stderr||String(check.error));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
