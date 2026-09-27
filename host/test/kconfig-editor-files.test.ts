import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir,symlink,lstat,stat,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseKconfig} from '../src/kconfig/parser.ts';
import {KconfigEditorFiles} from '../src/kconfig/editor-files.ts';
async function fixture(run:(directory:string,files:KconfigEditorFiles)=>Promise<void>){
 const directory=await mkdtemp(join(tmpdir(),'kconfig-files-'));
 try{
  await writeFile(join(directory,'Kconfig'),'config FLAG\n bool "Flag"\nconfig COUNT\n int "Count"\n default 2\n');
  const tree=await parseKconfig(directory,'Kconfig');
  await run(directory,await KconfigEditorFiles.open(directory,tree,join(directory,'.config')));
 }finally{await rm(directory,{recursive:true,force:true});}
}
test('editor saves and loads with backup, no-op timestamps and explicit overwrite/discard',async()=>{
 await fixture(async(dir,files)=>{
  assert.equal(files.editor.dirty,true);await files.save();assert.equal(files.editor.dirty,false);
  const initial=await readFile(files.path,'utf8');await assert.rejects(stat(files.path+'.old'),{code:'ENOENT'});
  const time=(await stat(files.path,{bigint:true})).mtimeNs;await files.save();assert.equal((await stat(files.path,{bigint:true})).mtimeNs,time);
  files.editor.set('FLAG','y');await files.save();assert.equal(await readFile(files.path+'.old','utf8'),initial);
  files.editor.set('COUNT','3');const output=join(dir,'other.config');await writeFile(output,initial);
  await assert.rejects(files.save(output),/confirm overwrite/);assert.equal(files.editor.dirty,true);assert.equal(await readFile(output,'utf8'),initial);
  await assert.rejects(files.load(output),/confirm discard/);await files.save(output,true);
  assert.equal(files.path,output);assert.equal(files.editor.dirty,false);assert.equal(await readFile(output+'.old','utf8'),initial);
  files.editor.set('COUNT','4');const minimal=join(dir,'minimal');await files.exportMinimal(minimal);assert.equal(files.editor.dirty,true);
  assert.match(await readFile(minimal,'utf8'),/CONFIG_COUNT=4/);
  await assert.rejects(files.exportMinimal(output,true),/active configuration/);
  await files.load(output,true);assert.equal(files.editor.value('COUNT'),'3');assert.equal(files.editor.dirty,false);
 });
});
test('external edits, invalid loads, locks and backup failures leave disk or editor changes intact',async()=>{
 await fixture(async(dir,files)=>{
  await files.save();files.editor.set('FLAG','y');const current=files.editor.full();
  await writeFile(files.path,'# external\n');await assert.rejects(files.save(),/changed externally/);assert.equal(await readFile(files.path,'utf8'),'# external\n');assert.equal(files.editor.full(),current);
  const invalid=join(dir,'invalid');await writeFile(invalid,Buffer.from([0xff]));await assert.rejects(files.load(invalid,true));assert.equal(files.editor.full(),current);
  await files.load(files.path,true);await files.save();files.editor.set('FLAG','y');
  const original=await readFile(files.path,'utf8');await writeFile(files.path+'.kconfig-lock','occupied');await assert.rejects(files.save(),{code:'EEXIST'});assert.equal(await readFile(files.path,'utf8'),original);await rm(files.path+'.kconfig-lock');
  await rm(files.path+'.old',{force:true});await mkdir(files.path+'.old');await assert.rejects(files.save());assert.equal(await readFile(files.path,'utf8'),original);assert.equal(files.editor.dirty,true);
  assert.equal((await readdir(dir)).some(name=>name.endsWith('.tmp')||name.endsWith('.kconfig-lock')),false);
  await assert.rejects(files.save(join(dir,'Kconfig'),true),/Kconfig source/);
 });
});
test('symlinks survive saves and retargeting is detected',async()=>{
 await fixture(async(dir,files)=>{
  const target=join(dir,'target'),link=join(dir,'link');await writeFile(target,files.editor.full(),{mode:0o600});await symlink(target,link);
  await files.load(link,true);files.editor.set('FLAG','y');await files.save();
  assert.equal((await lstat(link)).isSymbolicLink(),true);assert.equal((await stat(target)).mode&0o777,0o600);assert.match(await readFile(target,'utf8'),/CONFIG_FLAG=y/);
  const other=join(dir,'other');await writeFile(other,await readFile(target));await rm(link);await symlink(other,link);files.editor.set('COUNT','3');
  await assert.rejects(files.save(),/changed externally/);assert.doesNotMatch(await readFile(other,'utf8'),/CONFIG_COUNT=3/);
 });
});
test('edits made while a snapshot is saving remain dirty and can be saved afterwards',async()=>{
 await fixture(async(_dir,files)=>{
  await files.save();files.editor.set('FLAG','y');
  const pending=files.save();files.editor.set('COUNT','3');await pending;
  assert.equal(files.editor.dirty,true);assert.match(await readFile(files.path,'utf8'),/CONFIG_COUNT=2/);
  await files.save();assert.equal(files.editor.dirty,false);assert.match(await readFile(files.path,'utf8'),/CONFIG_COUNT=3/);
 });
});
