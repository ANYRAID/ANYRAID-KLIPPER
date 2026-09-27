import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
function menu(path:string,input:string){
 return spawnSync(process.execPath,[join(root,'scripts/kconfig-menuconfig.mjs'),'src/Kconfig'],{cwd:root,input,encoding:'utf8',timeout:15000,maxBuffer:2*1024*1024,env:{...process.env,srctree:root,KCONFIG_CONFIG:path,KCONFIG_CONFIG_HEADER:'',CONFIG_:'CONFIG_'}});
}
test('terminal command journey navigates, edits, saves, exports and reloads exact reference configuration',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'kconfig-menu-'));
 try{
  const reference=JSON.parse(await readFile(new URL('../contracts/kconfig-editor-reference.json',import.meta.url),'utf8'));
  const path=join(dir,'config'),minimal=join(dir,'minimal');
  const commands=['help','2','help 1','back','search MACH_STM32F446','all','root','all',...reference.steps.map((step:{name:string;value:string})=>'set '+step.name+' '+step.value),'save','export '+minimal,'set LOW_LEVEL_OPTIONS n','load '+path,'y','quit',''];
  const result=menu(path,commands.join('\n'));assert.equal(result.status,0,result.stderr+result.stdout.slice(-2000));
  assert.equal(await readFile(path,'utf8'),reference.steps.at(-1).full);
  assert.equal(await readFile(minimal,'utf8'),reference.steps.at(-1).minimal);
  assert.match(result.stdout,/Symbol: MACH_AVR/);assert.match(result.stdout,/Loaded configuration:/);assert.doesNotMatch(result.stdout,/Error:/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('terminal EOF and explicit discard do not save; overwrite cancellation leaves existing destination intact',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'kconfig-menu-abort-'));
 try{
  const path=join(dir,'config'),other=join(dir,'other');
  assert.equal(menu(path,'set LOW_LEVEL_OPTIONS y\n').status,1);await assert.rejects(stat(path),{code:'ENOENT'});
  assert.equal(menu(path,'set LOW_LEVEL_OPTIONS y\nquit\nd\n').status,0);await assert.rejects(stat(path),{code:'ENOENT'});
  await writeFile(other,'# keep\n');const result=menu(path,'save '+other+'\nn\nquit\nd\n');assert.equal(result.status,0,result.stderr);assert.equal(await readFile(other,'utf8'),'# keep\n');await assert.rejects(stat(path),{code:'ENOENT'});
 }finally{await rm(dir,{recursive:true,force:true});}
});
