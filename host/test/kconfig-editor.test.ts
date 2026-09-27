import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseKconfig} from '../src/kconfig/parser.ts';
import {KconfigEditor} from '../src/kconfig/editor.ts';
const root=fileURLToPath(new URL('../../',import.meta.url));
test('interactive architecture changes preserve hidden preferences and match Python after every edit',async()=>{
 const reference=JSON.parse(await readFile(new URL('../contracts/kconfig-editor-reference.json',import.meta.url),'utf8'));
 for(const [file,hash] of Object.entries({...reference.files,'lib/kconfiglib/kconfiglib.py':reference.sourceSha256}))assert.equal(createHash('sha256').update(await readFile(join(root,file))).digest('hex'),hash,file);
 const editor=new KconfigEditor(await parseKconfig(root));
 for(const step of reference.steps){
  editor.set(step.name,step.value);
  assert.equal(editor.full(),step.full,step.name+' full');
  assert.equal(editor.minimal(),step.minimal,step.name+' minimal');
 }
 assert.equal(editor.value('MACH_RP2350'),'y');
 assert.equal(editor.value('USB_SERIAL_NUMBER'),'print-"unit"\\test');
 editor.set('MACH_AVR','y');assert.equal(editor.value('SERIAL_BAUD'),'115200');
 assert.equal(reference.steps.length,15);
});
test('menu navigation, hidden search and help expose the actual configuration tree',async()=>{
 const editor=new KconfigEditor(await parseKconfig(root));
 const architecture=editor.items().find(item=>item.label==='Micro-controller Architecture')!;
 assert.equal(architecture.kind,'choice');assert.equal(editor.items(architecture.node).length,11);
 const stm32=editor.items(architecture.node).find(item=>item.name==='MACH_STM32')!;
 assert.equal(editor.parent(stm32.node),architecture.node);
 assert.deepEqual(editor.path(stm32.node),['Klipper Firmware Configuration','Micro-controller Architecture','STMicroelectronics STM32']);
 assert.equal(editor.search('MACH_STM32F446').length,0);
 assert.equal(editor.search('MACH_STM32F446',true)[0].visible,false);
 editor.set('MACH_STM32','y');assert.equal(editor.search('MACH_STM32F446')[0].visible,true);
 assert.match(editor.help(stm32.node),/src\/Kconfig:/);
 assert.match(editor.help(stm32.node),/Symbol: MACH_STM32/);
 assert.equal(editor.search('').length,0);
});
test('failed edits are atomic and dirty state only clears after exact saved contents',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'kconfig-editor-'));
 try{
  await writeFile(join(directory,'Kconfig'),'config ENABLE\n bool "Enable"\nconfig COUNT\n int "Count"\n range 0 29\n default 2\nconfig HIDDEN\n bool\n default y\n');
  const editor=new KconfigEditor(await parseKconfig(directory,'Kconfig'));
  const initial=editor.full();editor.markSaved(initial);assert.equal(editor.dirty,false);
  for(const [name,value] of [['COUNT','30'],['COUNT','bad'],['HIDDEN','n'],['MISSING','y'],['ENABLE','m']]){
   assert.throws(()=>editor.set(name,value));assert.equal(editor.full(),initial);assert.equal(editor.dirty,false);
  }
  editor.set('ENABLE','y');assert.equal(editor.dirty,true);assert.throws(()=>editor.markSaved(initial));
  const changed=editor.full();editor.markSaved(changed);assert.equal(editor.dirty,false);
  editor.reset();assert.equal(editor.full(),initial);assert.equal(editor.dirty,true);
  editor.load(changed);assert.equal(editor.dirty,false);assert.equal(editor.value('ENABLE'),'y');
 }finally{await rm(directory,{recursive:true,force:true});}
});
