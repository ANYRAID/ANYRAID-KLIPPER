import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
const script=fileURLToPath(new URL('../scripts/diagnose-motion-affinity.mjs',import.meta.url));
for(const mode of ['pass','failure','mutation'])test(`motion affinity runner validates ${mode} without hiding failures`,{skip:process.platform!=='linux'},()=>{
 const root=mkdtempSync(join(tmpdir(),'affinity-control-'));
 try{
  const compiled=join(root,'compiled'),fixture=join(root,'fixture.mjs'),report=join(root,'report');mkdirSync(compiled);writeFileSync(join(compiled,'input.json'),'{}');
  const cpu=/^Cpus_allowed_list:\s*(\d+)/m.exec(readFileSync('/proc/self/status','utf8'))![1];
  writeFileSync(fixture,`import {writeFileSync} from 'node:fs';
console.log('motion:loading');console.log('motion:loaded');
${mode==='failure'?"writeFileSync(new URL('motion-mismatch-'+process.pid+'-0.bin',import.meta.url),Buffer.from('injected'));throw Error('injected mismatch');":mode==='mutation'?"writeFileSync(new URL('./compiled/input.json',import.meta.url),'changed');":''}
console.log('motion:verified');`);
  const r=spawnSync(process.execPath,[script,'--fixture',fixture,'--node',process.execPath,'--cpus',cpu,'--rounds','2','--report',report],{encoding:'utf8',timeout:20000});
  assert.equal(r.error,undefined);assert.equal(r.signal,null);assert.equal(r.status,mode==='pass'?0:1,r.stderr);
  const result=JSON.parse(readFileSync(join(report,'report.json'),'utf8'));assert.equal(result.state,mode==='pass'?'completed':mode==='failure'?'failed':'input-changed');assert.equal(result.results.length,mode==='pass'?2:1);
  assert.ok(result.results[0].stdout.startsWith('affinity:'+cpu+'\n'));
  if(mode==='failure'){const capture=result.results[0].captures[0],bytes=gunzipSync(readFileSync(join(report,capture.file)));assert.equal(bytes.toString(),'injected');assert.equal(createHash('sha256').update(bytes).digest('hex'),capture.rawSHA256);assert.equal(result.results[0].verified,false);}
  if(mode==='mutation')assert.equal(result.results[0].inputsUnchanged,false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
