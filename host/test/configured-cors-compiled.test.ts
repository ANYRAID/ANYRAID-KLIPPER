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
test('configured CORS HTTP and WebSocket run in an independent compiled product without Python or TS loading',{timeout:180000},async t=>{
 const retained=await externalAcceptanceBundle(),root=await mkdtemp(join(tmpdir(),'compiled-cors-')),app=retained?.path??join(root,'app');
 try{
  if(retained)await assertSeparateAcceptanceWorkspace(retained,root);
  else{await buildProductHost(app);await installProductDependencies(app);}
  // Reuse the same protocol assertions; only imports and TS syntax change.
  const source=await readFile(new URL('./configured-cors.test.ts',import.meta.url),'utf8');
  const js=stripTypeScriptTypes(source,{mode:'strip'})
   .replace(/'\.\.\/src\/moonraker\/(configured-server|database)\.ts'/g,(_all,name)=>JSON.stringify(pathToFileURL(join(app,'host/src/moonraker',name+'.js')).href))
   .replace("from 'ws'",'from '+JSON.stringify(pathToFileURL(join(app,'node_modules/ws/wrapper.mjs')).href));
  const script=join(root,'check.mjs');await writeFile(script,js);
  const env:NodeJS.ProcessEnv={...process.env,PATH:'/no-programs',NODE_PATH:'',NODE_OPTIONS:'--no-experimental-strip-types',NODE_DISABLE_COMPILE_CACHE:'1'};
  delete env.NODE_TEST_CONTEXT;
  const result=await execute(process.execPath,['--no-experimental-strip-types','--test','--test-reporter=tap',script],{env,timeout:30000,maxBuffer:2*1024**2});
  assert.match(result.stdout,/pass 2\b/);assert.match(result.stdout,/fail 0\b/);
  t.diagnostic(JSON.stringify({compiled:true,protocolTests:2,independentDependencies:true,noTypeScriptLoading:true,...retained?{bundle:retained}:{},scope:'Real local HTTP and WebSocket authorization checks; no official-client or target-hardware acceptance'}));
 }finally{try{if(retained)await assertAcceptanceBundleUnchanged(retained);}finally{await rm(root,{recursive:true,force:true});}}
});
