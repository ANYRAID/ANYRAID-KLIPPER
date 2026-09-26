import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,symlink,readFile,readdir,rm,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {buildProductNative,productAddons} from '../scripts/build-product-native.ts';
test('fresh native build uses C-only PATH, binds sources to outputs and preserves existing destinations',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'native-build-')),bin=join(dir,'bin'),output=join(dir,'addons'),originalPath=process.env.PATH,originalCC=process.env.CC;
 try{
  await mkdir(bin);for(const program of ['cc','as','ld'])await symlink('/usr/bin/'+program,join(bin,program));
  process.env.PATH=bin;process.env.CC=join(bin,'cc');const begin=performance.now();await buildProductNative(output);
  const text=await readFile(join(output,'native-build-info.json'),'utf8'),record=JSON.parse(text);
  assert.deepEqual(Object.keys(record.outputs),productAddons.map(name=>name+'.node'));assert(Object.keys(record.sources).every(name=>!name.endsWith('.py')));assert(record.sources['host/native/trapq.c']);assert(record.sources['klippy/chelper/itersolve.c']);assert(record.nodeHeaders['node_api.h']);
  for(const [name,hash] of Object.entries(record.outputs))assert.equal(createHash('sha256').update(await readFile(join(output,name))).digest('hex'),hash);
  await assert.rejects(buildProductNative(output),{code:'EEXIST'});assert.equal(await readFile(join(output,'native-build-info.json'),'utf8'),text);
  t.diagnostic(JSON.stringify({freshBuildMs:performance.now()-begin,sourceFiles:Object.keys(record.sources).length,nodeHeaderFiles:Object.keys(record.nodeHeaders).length,compiler:record.compiler,outputs:record.outputs}));
  process.env.CC='/no-compiler';await assert.rejects(buildProductNative(join(dir,'failed')),/compiler unavailable/);await assert.rejects(access(join(dir,'failed')),{code:'ENOENT'});
  assert.deepEqual((await readdir(dir)).sort(),['addons','bin']);
 }finally{if(originalPath===undefined)delete process.env.PATH;else process.env.PATH=originalPath;if(originalCC===undefined)delete process.env.CC;else process.env.CC=originalCC;await rm(dir,{recursive:true,force:true});}
});
