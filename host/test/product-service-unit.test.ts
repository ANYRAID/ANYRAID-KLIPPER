import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {productServiceUnit,productServiceUnitCLI} from '../src/runtime/product-service-unit.ts';
async function fixture(run:(f:{root:string;bundle:string;profile:string;entry:string;marker:Record<string,unknown>})=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'native-service-'));
 try{const bundle=join(root,'bundle %u $HOME "quoted"'),profile=join(root,'machine %u $HOME "quoted".mjs'),entry=join(bundle,'scripts/product-host.js');await mkdir(join(bundle,'scripts'),{recursive:true});
 await writeFile(profile,'throw new Error("MUST NOT IMPORT MACHINE DURING PREPARATION");');await writeFile(entry,'process.exit(0);');
 const marker={schema:1,product:'anyraid-product-host',platform:process.platform,arch:process.arch,modules:process.versions.modules,files:{'scripts/product-host.js':createHash('sha256').update(await readFile(entry)).digest('hex')}};
 await writeFile(join(bundle,'build-info.json'),JSON.stringify(marker));await run({root,bundle,profile,entry,marker});}finally{await rm(root,{recursive:true,force:true});}
}
test('read-only unit generation escapes systemd paths and passes installed parser',async()=>fixture(async({root,bundle,profile})=>{
 const unit=await productServiceUnit({bundle,profile,user:'printer'});
 assert.match(unit,/Restart=no\n/);assert.match(unit,/KillMode=mixed\n/);assert.match(unit,/Conflicts=klipper.service moonraker.service/);
 assert.match(unit,/ExecStart=.*--no-experimental-strip-types/);assert(unit.includes(String.raw`%%u $HOME \"quoted\"`));assert(!unit.includes('ExecReload='));
 const path=join(root,'anyraid-host.service');await writeFile(path,unit);const result=spawnSync('systemd-analyze',['verify',path],{encoding:'utf8'});
 assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);assert(!/Failed to parse|Unknown|Invalid/u.test(result.stderr),result.stderr);
}));
test('rejects corrupted bundle, mismatched ABI and unsafe inventory paths',async()=>fixture(async({bundle,profile,entry,marker})=>{
 const options={bundle,profile,user:'printer'};await writeFile(entry,'tampered');await assert.rejects(productServiceUnit(options),/digest mismatch/);
 await writeFile(join(bundle,'build-info.json'),JSON.stringify({...marker,modules:'wrong'}));await assert.rejects(productServiceUnit(options),/ABI/);
 await writeFile(join(bundle,'build-info.json'),JSON.stringify({...marker,files:{...(marker.files as object),'../escape':'a'.repeat(64)}}));await writeFile(entry,'process.exit(0);');await assert.rejects(productServiceUnit(options),/inventory entry/);
}));
test('rejects root, replaceable profiles, source modules and symlink control characters',async()=>fixture(async({root,bundle,profile})=>{
 await assert.rejects(productServiceUnit({bundle,profile,user:'root'}),/non-root/);
 await assert.rejects(productServiceUnit({bundle,profile,user:'printer\nRestart=always'}),/non-root/);
 const internal=join(bundle,'machine.mjs');await writeFile(internal,'');await assert.rejects(productServiceUnit({bundle,profile:internal,user:'printer'}),/outside/);
 const source=join(root,'machine.ts');await writeFile(source,'');await assert.rejects(productServiceUnit({bundle,profile:source,user:'printer'}),/regular/);
 const hidden=join(root,'bad\npath.mjs'),link=join(root,'link.mjs');await writeFile(hidden,'');await symlink(hidden,link);await assert.rejects(productServiceUnit({bundle,profile:link,user:'printer'}),/control characters/);
}));
test('CLI rejects missing, duplicate and unknown flags before producing any unit',async()=>{
 let output='';const write=(text:string)=>{output+=text;};await productServiceUnitCLI(['--help'],write);assert.match(output,/Does not install/);output='';
 for(const args of [[],['--bundle','/tmp'],['--bundle','/tmp','--bundle','/tmp','--user','printer'],['--install','true']])await assert.rejects(productServiceUnitCLI(args,write),/Expected exactly/);
 assert.equal(output,'');
});
