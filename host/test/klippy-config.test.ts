import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolveKlippyPath,readKlippyBinding} from '../src/moonraker/klippy-config.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
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
