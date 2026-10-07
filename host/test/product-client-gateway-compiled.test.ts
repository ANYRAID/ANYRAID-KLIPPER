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
test('protected client gateway and installed assets run from independent compiled product with unchanged protocol assertions',{timeout:180000},async t=>{
 const retained=await externalAcceptanceBundle(),root=await mkdtemp(join(tmpdir(),'compiled-client-gateway-')),app=retained?.path??join(root,'app');
 try{
  if(retained)await assertSeparateAcceptanceWorkspace(retained,root);else{await buildProductHost(app);await installProductDependencies(app);}
  const files:string[]=[];
  for(const name of ['product-client-gateway','product-client-assets']){
   const source=await readFile(new URL('./'+name+'.test.ts',import.meta.url),'utf8'),js=stripTypeScriptTypes(source,{mode:'strip'}).replace(/'\.\.\/src\/((?:moonraker|runtime)\/[a-z-]+)\.ts'/g,(_all,path)=>JSON.stringify(pathToFileURL(join(app,'host/src',path+'.js')).href)).replace("from 'ws'",'from '+JSON.stringify(pathToFileURL(join(app,'node_modules/ws/wrapper.mjs')).href));
   const file=join(root,name+'.mjs');await writeFile(file,js);files.push(file);
  }
  const env:NodeJS.ProcessEnv={...process.env,PATH:'/no-programs',NODE_PATH:'',NODE_OPTIONS:'--no-experimental-strip-types',NODE_DISABLE_COMPILE_CACHE:'1'};delete env.NODE_TEST_CONTEXT;
  const result=await execute(process.execPath,['--no-experimental-strip-types','--test','--test-reporter=tap',...files],{env,timeout:30000,maxBuffer:2*1024**2});assert.match(result.stdout,/tests 9\b/);assert.match(result.stdout,/pass 9\b/);assert.match(result.stdout,/fail 0\b/);assert.match(result.stdout,/cancelled 0\b/);assert.match(result.stdout,/skipped 0\b/);
  const help=await execute(process.execPath,['--no-experimental-strip-types',join(app,'scripts/product-client.js'),'--help'],{env,timeout:10000});assert.match(help.stdout,/--upstream/);assert.match(help.stdout,/--assets/);
  t.diagnostic(JSON.stringify({compiled:true,independentDependencies:true,protocolAndAssetTests:9,noTypeScriptLoading:true,compiledClientCliHelp:true,...retained?{bundle:retained}:{},scope:'Original real local native-account HTTP/WebSocket and installed-resource assertions plus protected queue-page identity; actual official client page and physical hardware excluded'}));
 }finally{try{if(retained)await assertAcceptanceBundleUnchanged(retained);}finally{await rm(root,{recursive:true,force:true});}}
});
