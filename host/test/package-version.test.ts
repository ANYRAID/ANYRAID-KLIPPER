import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {packageVersion} from '../src/build/version.ts';
test('version respects tags, tracked dirtiness, untracked files and detached HEAD',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'anyraid-version-'));
 const git=(...args:string[])=>execFileSync('git',['-C',dir,...args],{encoding:'utf8'}).trim();
 try {
  git('init','-q');git('config','user.name','版本测试');git('config','user.email','version-test@example.invalid');
  writeFileSync(join(dir,'tracked'),'one');git('add','tracked');git('commit','-qm','test: 创建版本测试夹具');git('tag','v1.0');
  const expected=git('describe','--always','--tags','--long','--dirty');
  assert.equal(await packageVersion(dir,' Test Distro '),expected+'-TestDistro');
  writeFileSync(join(dir,'untracked'),'ignored');assert.equal(await packageVersion(dir,'a'),expected+'-a');
  writeFileSync(join(dir,'tracked'),'two');assert.equal(await packageVersion(dir,'a'),expected+'-dirty-a');
  git('add','tracked');git('commit','-qm','test: 更新版本测试夹具');git('checkout','--detach','-q');
  assert.equal(await packageVersion(dir,'a'),git('describe','--always','--tags','--long','--dirty')+'-a');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('source archive and unavailable git preserve fallback, distro is never executed',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'anyraid-version-'));
 try {
  assert.equal(await packageVersion(dir,'Archive'), '?-Archive');
  assert.equal(await packageVersion(dir,'$(touch bad) `id`','/missing/git'), '?-$(touchbad)`id`');
  await assert.rejects(packageVersion(dir,'a\nb'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('CLI runs from another directory without host dependencies and validates arguments',()=>{
 const script=fileURLToPath(new URL('../../scripts/make_version.mts',import.meta.url));
 const run=(...args:string[])=>execFileSync(process.execPath,[script,...args],{cwd:tmpdir(),encoding:'utf8',stdio:['ignore','pipe','pipe']});
 assert.match(run('Build Distro'),/-BuildDistro\n$/);assert.match(run('--','-custom'),/--custom\n$/);assert.match(run('--help'),/Usage:/);
 assert.throws(()=>run());assert.throws(()=>run('a','b'));assert.throws(()=>run('a\nb'));
});
