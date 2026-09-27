import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {parseKconfig} from '../src/kconfig/parser.ts';
import {loadKconfigConfiguration,kconfigAutoconf} from '../src/kconfig/configuration.ts';
const root=fileURLToPath(new URL('../../',import.meta.url));
test('all 84 configurations load from real files and generate byte-identical autoconf headers',async()=>{
 const reference=JSON.parse(await readFile(new URL('../contracts/kconfig-autoconf-reference.json',import.meta.url),'utf8'));
 const modelReference=JSON.parse(await readFile(new URL('../contracts/kconfig-model-reference.json',import.meta.url),'utf8'));
 assert.equal(reference.sourceSha256,modelReference.sourceSha256);
 for(const [file,hash] of Object.entries({...modelReference.files,[modelReference.source]:modelReference.sourceSha256}))assert.equal(createHash('sha256').update(await readFile(join(root,file))).digest('hex'),hash,file);
 const tree=await parseKconfig(root);
 for(const c of reference.cases){
  const input=await readFile(join(root,c.file),'utf8');
  const modelCase=modelReference.cases.find((v:{file:string;lowlevel:boolean})=>v.file===c.file&&v.lowlevel===c.lowlevel);
  assert.equal(createHash('sha256').update(input).digest('hex'),modelCase.sha256);
  const {model}=loadKconfigConfiguration(tree,input+(c.lowlevel?'\nCONFIG_LOW_LEVEL_OPTIONS=y\n':''));
  const header=kconfigAutoconf(model);
  assert.equal(Buffer.byteLength(header),c.bytes,c.file);
  assert.equal(createHash('sha256').update(header).digest('hex'),c.sha256,c.file+' lowlevel='+c.lowlevel);
 }
 assert.equal(reference.cases.length,84);
});
test('configuration loader preserves escaping, repeated choice history and invalid assignment fallback',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'kconfig-load-'));
 try{
  await writeFile(join(dir,'Kconfig'),'config TEXT\n string "Text"\nconfig NUMBER\n int "Number"\n default 42\nchoice\n prompt "Pick"\nconfig A\n bool "A"\nconfig B\n bool "B"\nendchoice\n');
  const tree=await parseKconfig(dir,'Kconfig');
  const {model,warnings}=loadKconfigConfiguration(tree,'CONFIG_TEXT="a\\\\b\\\"c\\n" trailing\nCONFIG_NUMBER=bad\nCONFIG_MISSING=y\nCONFIG_A=y\nCONFIG_B=y\nCONFIG_B=n\n');
  assert.equal(model.value('TEXT').text,'a\\b"cn');
  assert.equal(model.value('NUMBER').text,'42');
  assert.equal(model.value('A').text,'n');assert.equal(model.value('B').text,'y');
  assert.equal(warnings.length,3);
  assert.match(kconfigAutoconf(model),/#define CONFIG_TEXT "a\\\\b\\"cn"/);
  assert.equal(loadKconfigConfiguration(tree,'CFG_NUMBER=001\n','CFG_').model.value('NUMBER').text,'001');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('CLI honors output headers, preserves unchanged mtime and retains output on parse failure',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'kconfig-cli-'));
 try{
  const source='config ENABLE\n bool "Enable"\nconfig TITLE\n string "Title"\n default "test"\n';
  await writeFile(join(dir,'Kconfig'),source);await writeFile(join(dir,'.config'),'CUSTOM_ENABLE=y\n');
  const env={...process.env,srctree:dir,KCONFIG_CONFIG:join(dir,'.config'),KCONFIG_AUTOHEADER:join(dir,'autoconf.h'),KCONFIG_AUTOHEADER_HEADER:'/* custom */\n',CONFIG_:'CUSTOM_'};
  const run=(args=['Kconfig'],overrides:Record<string,string>={})=>spawnSync(process.execPath,[join(root,'scripts/kconfig-genconfig.mjs'),...args],{env:{...env,...overrides},encoding:'utf8'});
  const first=run();assert.equal(first.status,0,first.stderr);
  const output=await readFile(env.KCONFIG_AUTOHEADER,'utf8');assert.equal(output,'/* custom */\n#define CUSTOM_ENABLE 1\n#define CUSTOM_TITLE "test"\n');
  const before=await stat(env.KCONFIG_AUTOHEADER,{bigint:true});assert.equal(run().status,0);
  assert.equal((await stat(env.KCONFIG_AUTOHEADER,{bigint:true})).mtimeNs,before.mtimeNs);
  assert.equal(run(['Kconfig'],{NODE_DISABLE_COMPILE_CACHE:'1'}).status,0);
  assert.equal((await stat(env.KCONFIG_AUTOHEADER,{bigint:true})).mtimeNs,before.mtimeNs);
  assert.equal(run(['--header-path',env.KCONFIG_CONFIG,'Kconfig']).status,1);
  assert.equal(await readFile(env.KCONFIG_CONFIG,'utf8'),'CUSTOM_ENABLE=y\n');
  await writeFile(join(dir,'Kconfig'),'unknown directive\n');assert.equal(run().status,1);
  assert.equal(await readFile(env.KCONFIG_AUTOHEADER,'utf8'),output);
 }finally{await rm(dir,{recursive:true,force:true});}
});
