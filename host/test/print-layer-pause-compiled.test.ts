import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {stripTypeScriptTypes} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {buildProductHost} from '../scripts/build-product-host.ts';
import {installProductDependencies} from './helpers/product-install.ts';
import {externalAcceptanceBundle,assertSeparateAcceptanceWorkspace,assertAcceptanceBundleUnchanged} from './helpers/acceptance-bundle.ts';
const execute=promisify(execFile);
test('layer pause ownership, file boundary and failure cleanup run in an independent compiled product',{timeout:180000},async t=>{
 const retained=await externalAcceptanceBundle(),root=await mkdtemp(join(tmpdir(),'compiled-layer-pause-')),app=retained?.path??join(root,'app');
 try{
  if(retained)await assertSeparateAcceptanceWorkspace(retained,root);
  else{await buildProductHost(app);await installProductDependencies(app);}
  const source=await readFile(new URL('./print-layer-pause.test.ts',import.meta.url),'utf8');
  const js=stripTypeScriptTypes(source,{mode:'strip'}).replace(/from '\.\.\/src\/([^']+)\.ts'/g,(_all,path)=>'from '+JSON.stringify(pathToFileURL(join(app,'host/src',path+'.js')).href));
  const script=join(root,'check.mjs');await writeFile(script,js);
  const env:NodeJS.ProcessEnv={...process.env,PATH:'/no-programs',NODE_PATH:'',NODE_OPTIONS:'--no-experimental-strip-types',NODE_DISABLE_COMPILE_CACHE:'1'};delete env.NODE_TEST_CONTEXT;
  const result=await execute(process.execPath,['--no-experimental-strip-types','--test','--test-reporter=tap',script],{env,timeout:30000,maxBuffer:2*1024**2});
  assert.match(result.stdout,/pass 11\b/);assert.match(result.stdout,/fail 0\b/);
  t.diagnostic(JSON.stringify({compiled:true,regressions:11,noTypeScriptLoading:true,independentDependencies:true,...retained?{bundle:retained}:{},scope:'Software file admission and original controller pause with fake device acknowledgements; overlaps the eleven source cases. No complete native mixed load, frontend, target board or G3 acceptance.'}));
 }finally{try{if(retained)await assertAcceptanceBundleUnchanged(retained);}finally{await rm(root,{recursive:true,force:true});}}
});
