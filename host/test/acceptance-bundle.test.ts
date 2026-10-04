import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {inspectAcceptanceBundle,externalAcceptanceBundle,assertSeparateAcceptanceWorkspace,assertAcceptanceBundleUnchanged} from './helpers/acceptance-bundle.ts';

async function fixture(run:(f:{root:string;bundle:string;entry:string;dependency:string})=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'acceptance-identity-')),bundle=join(root,'bundle'),entry=join(bundle,'scripts/product-host.js'),dependency=join(bundle,'node_modules/runtime/index.js');
 try{
  await mkdir(join(bundle,'scripts'),{recursive:true});await mkdir(join(bundle,'node_modules/runtime'),{recursive:true});
  await writeFile(entry,'throw new Error("IDENTITY CHECK MUST NEVER RUN PRODUCT");');await writeFile(dependency,'export const version=1;');
  await writeFile(join(bundle,'node_modules/runtime/package.json'),JSON.stringify({name:'runtime',version:'1.0.0'}));
  await writeFile(join(bundle,'package.json'),JSON.stringify({dependencies:{runtime:'1.0.0'}}));
  await writeFile(join(bundle,'package-lock.json'),JSON.stringify({packages:{'node_modules/runtime':{version:'1.0.0'}}}));
  await writeFile(join(bundle,'build-info.json'),JSON.stringify({schema:1,product:'anyraid-product-host',platform:process.platform,arch:process.arch,modules:process.versions.modules,files:{'scripts/product-host.js':createHash('sha256').update(await readFile(entry)).digest('hex')}}));
  await run({root,bundle,entry,dependency});
 }finally{await rm(root,{recursive:true,force:true});}
}
test('retained identity is read only and requires all three reuse values',async()=>fixture(async({bundle,dependency})=>{
 const before=await readFile(dependency),identity=await inspectAcceptanceBundle(bundle);
 const env={ANYRAID_ACCEPTANCE_BUNDLE:bundle,ANYRAID_ACCEPTANCE_MANIFEST_SHA256:identity.manifestSha256,ANYRAID_ACCEPTANCE_DEPENDENCIES_SHA256:identity.dependenciesSha256};
 assert.deepEqual(await externalAcceptanceBundle(env),identity);assert.deepEqual(await readFile(dependency),before);
 assert.equal(await externalAcceptanceBundle({}),undefined);
 for(const key of Object.keys(env))await assert.rejects(externalAcceptanceBundle({...env,[key]:undefined}),/requires bundle/);
 await assert.rejects(externalAcceptanceBundle({...env,ANYRAID_ACCEPTANCE_MANIFEST_SHA256:'bad'}),/requires bundle/);
 await assert.rejects(externalAcceptanceBundle({...env,ANYRAID_ACCEPTANCE_MANIFEST_SHA256:'0'.repeat(64)}),/identity changed/);
 await writeFile(dependency,'export const version=2;');await assert.rejects(externalAcceptanceBundle(env),/identity changed/);
}));
test('changed product inventory and ABI reject before any product execution',async()=>fixture(async({bundle,entry})=>{
 await writeFile(entry,'throw new Error("ALTERED PRODUCT MUST NEVER RUN");');await assert.rejects(inspectAcceptanceBundle(bundle),/digest mismatch/);
 const marker=JSON.parse(await readFile(join(bundle,'build-info.json'),'utf8'));await writeFile(join(bundle,'build-info.json'),JSON.stringify({...marker,modules:'wrong'}));await assert.rejects(inspectAcceptanceBundle(bundle),/ABI/);
}));
test('dependency versions and development tools cannot masquerade as production install',async()=>fixture(async({bundle})=>{
 const path=join(bundle,'node_modules/runtime/package.json');await writeFile(path,JSON.stringify({version:'2.0.0'}));await assert.rejects(inspectAcceptanceBundle(bundle),/version differs/);
 await writeFile(path,JSON.stringify({version:'1.0.0'}));await mkdir(join(bundle,'node_modules/typescript'));await assert.rejects(inspectAcceptanceBundle(bundle),/development dependency/);
}));
test('independent install rejects module roots and individual dependencies that are links',async()=>fixture(async({root,bundle})=>{
 const modules=join(bundle,'node_modules');await rm(modules,{recursive:true});await mkdir(join(root,'shared'));await symlink(join(root,'shared'),modules);await assert.rejects(inspectAcceptanceBundle(bundle),/independently installed/);
 await rm(modules);await mkdir(modules);await symlink(join(root,'shared'),join(modules,'runtime'));await assert.rejects(inspectAcceptanceBundle(bundle),/independent directory/);
}));
test('internal dependency links are bound, escaped links reject',async()=>fixture(async({root,bundle})=>{
 const link=join(bundle,'node_modules/runtime/link.js');await symlink('index.js',link);const first=await inspectAcceptanceBundle(bundle);assert.equal((await inspectAcceptanceBundle(bundle)).dependenciesSha256,first.dependenciesSha256);
 await writeFile(join(root,'outside.js'),'external');await rm(link);await symlink('../../../outside.js',link);await assert.rejects(inspectAcceptanceBundle(bundle),/escapes installed tree/);
}));
test('canonical workspace overlap is rejected in either direction including aliases',async()=>fixture(async({root,bundle})=>{
 const identity=await inspectAcceptanceBundle(bundle),outside=join(root,'data'),inside=join(bundle,'data'),alias=join(root,'alias');await mkdir(outside);await mkdir(inside);await symlink(inside,alias);
 await assertSeparateAcceptanceWorkspace(identity,outside);
 for(const workspace of [root,bundle,inside,alias])await assert.rejects(assertSeparateAcceptanceWorkspace(identity,workspace),/overlaps retained bundle/);
}));

test('post-run verification remains bound to the pinned package without environment reuse',async()=>fixture(async({bundle,dependency})=>{
 const expected=await inspectAcceptanceBundle(bundle);await assertAcceptanceBundleUnchanged(expected);
 await writeFile(dependency,'export const changed=true;');await assert.rejects(assertAcceptanceBundleUnchanged(expected),/identity changed/);
}));
