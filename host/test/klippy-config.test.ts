import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,symlink,rm} from 'node:fs/promises';
import {tmpdir,userInfo} from 'node:os';
import {join,relative} from 'node:path';
import {resolveKlippyPath,readKlippyBinding} from '../src/moonraker/klippy-config.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {MoonrakerTemplateFactory} from '../src/moonraker/template-factory.ts';
const reader=(options:Record<string,string>)=>new ConfigurationReader(new ConfigurationSource('/config/main.conf',{server:options},[]));
test('Klippy binding consumes the upstream default and validates retry/path limits',async()=>{
 const r=reader({});assert.deepEqual(await readKlippyBinding(r),{path:'/tmp/klippy_uds',retryDelayMs:250});assert.equal(r.parsed().server.klippy_uds_address,'/tmp/klippy_uds');assert.equal((await readKlippyBinding(reader({}),{render(){throw new Error('Default must not be rendered');}})).path,'/tmp/klippy_uds');
 for(const value of ['', '\0', '/'+ 'x'.repeat(108), '~anotheruser/socket'])await assert.rejects(resolveKlippyPath(value));
 for(const retry of [0,-1,1.5,60001,NaN])await assert.rejects(readKlippyBinding(reader({}),{},retry));
});
test('path resolution follows symlinks before dot-dot, including dangling link targets',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'kp-'));try{await mkdir(join(dir,'real','nested'),{recursive:true});await symlink(join(dir,'real','nested'),join(dir,'link'));await symlink('absent/nested',join(dir,'dangling'));
 assert.equal(await resolveKlippyPath('link/../api.sock',{cwd:dir}),join(dir,'real','api.sock'));
 assert.equal(await resolveKlippyPath('dangling/../api.sock',{cwd:dir}),join(dir,'absent','api.sock'));
 assert.equal(await resolveKlippyPath('~/api.sock',{home:dir}),join(dir,'api.sock'));
 await symlink('loop',join(dir,'loop'));await assert.rejects(resolveKlippyPath(join(dir,'loop')),/symlink/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('path templates require an explicit renderer and are never silently used as literal paths',async()=>{
 await assert.rejects(resolveKlippyPath('{data_path}/comms/klippy.sock'),/renderer/);
 let source='';assert.equal(await resolveKlippyPath(' {data_path}/comms/klippy.sock ',{render:s=>{source=s;return '/tmp/printer/comms/klippy.sock';}}),'/tmp/printer/comms/klippy.sock');assert.equal(source,'{data_path}/comms/klippy.sock');
 await assert.rejects(resolveKlippyPath('value',{render:async()=>{throw new Error('Template failed');}}),/Template failed/);
});
test('path whitespace follows Python strip and rejects relative home overrides',async()=>{
 assert.equal(await resolveKlippyPath('\x1c/tmp/klippy_uds\x1c'),'/tmp/klippy_uds');assert.equal(await resolveKlippyPath('\ufeffsocket',{cwd:'/tmp'}),'/tmp/\ufeffsocket');await assert.rejects(resolveKlippyPath('~/socket',{home:'relative'}),/absolute/);
});
test('explicit Klippy contexts expand named accounts independently of HOME and retain physical long-chain semantics',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'kp-')),info=userInfo(),home=process.env.HOME;
 try{
  process.env.HOME=join(dir,'wrong-home');await mkdir(join(dir,'real','nested'),{recursive:true});
  const named='~'+info.username+'/'+relative(info.homedir,dir)+'/api.sock';assert.equal(await resolveKlippyPath(named,{home:join(dir,'other')}),join(dir,'api.sock'));
  assert.equal(await resolveKlippyPath('./~//api.sock',{home:dir}),join(dir,'api.sock'));
  for(let i=0;i<60;i++)await symlink(i===59?'real/nested':'c'+(i+1),join(dir,'c'+i));
  assert.equal(await resolveKlippyPath('c0/../api.sock',{cwd:dir}),join(dir,'real','api.sock'));
  await symlink('real',join(dir,'repeat'));assert.equal(await resolveKlippyPath('repeat/../repeat/api.sock',{cwd:dir}),join(dir,'real','api.sock'));
  await symlink('second',join(dir,'first'));await symlink('first',join(dir,'second'));await assert.rejects(resolveKlippyPath('first/socket',{cwd:dir}),error=>error instanceof Error&&/symlink/.test(error.message)&&!error.message.includes(dir));
  await assert.rejects(resolveKlippyPath('~anyraid_missing_user_7281/socket'),error=>error instanceof Error&&!error.message.includes('7281'));
 }finally{if(home===undefined)delete process.env.HOME;else process.env.HOME=home;await rm(dir,{recursive:true,force:true});}
});
test('Klippy fallback uses empty, relative and unset environment HOME without changing explicit-home validation',async()=>{
 const home=process.env.HOME;try{
  process.env.HOME='';assert.equal(await resolveKlippyPath('~/socket'),'/socket');
  process.env.HOME='relative';assert.equal(await resolveKlippyPath('./~/socket',{cwd:'/tmp'}),'/tmp/relative/socket');
  delete process.env.HOME;assert.equal(await resolveKlippyPath('~/socket'),join(userInfo().homedir,'socket'));
 }finally{if(home===undefined)delete process.env.HOME;else process.env.HOME=home;}
});
test('Klippy context overrides preserve shared private template ownership, defaults and transient handle release',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'kp-')),config=reader({klippy_uds_address:'{data_path}/api.sock'});let factory:MoonrakerTemplateFactory|undefined;
 try{
  factory=await MoonrakerTemplateFactory.load(config,{dataPath:dir});
  for(let i=0;i<20;i++){assert.equal((await readKlippyBinding(config,{cwd:'/tmp'})).path,join(dir,'api.sock'));assert.equal(factory.toJSON().templates,0);}
  assert.equal(config.parsed().server.klippy_uds_address,'{data_path}/api.sock');
  await assert.rejects(readKlippyBinding(config,{render:()=>'/other/socket'}),/one Klippy template dependency/);assert.equal(factory.toJSON().templates,0);
  const release=reader({klippy_uds_address:'{% if'}),unbind=release.bindTemplates(factory);try{await assert.rejects(readKlippyBinding(release,{home:dir}));assert.equal(factory.toJSON().templates,0);}finally{unbind();}
  const bounds=reader({klippy_uds_address:'/'+ 'x'.repeat(108)}),drop=bounds.bindTemplates(factory);try{await assert.rejects(readKlippyBinding(bounds,{cwd:'/tmp'}),/Unix socket path/);assert.equal(factory.toJSON().templates,0);}finally{drop();}
  const missing=reader({}),detach=missing.bindTemplates(factory);try{assert.equal((await readKlippyBinding(missing,{cwd:'/other'})).path,'/tmp/klippy_uds');assert.equal(factory.toJSON().templates,0);}finally{detach();}
 }finally{factory?.close();await rm(dir,{recursive:true,force:true});}
});
