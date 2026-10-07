import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer,request as httpRequest} from 'node:http';
import {productClientAssets} from '../src/runtime/product-client-assets.ts';
test('installed client resources preserve exact bytes, separate login shell, and exclude outside assets',async()=>{
 const root=await mkdtemp(join(tmpdir(),'client-assets-')),assets=join(root,'assets');let server:ReturnType<typeof createServer>|undefined;
 try{
  await mkdir(assets);await writeFile(join(assets,'index.html'),'<html>fixed official client</html>');await writeFile(join(assets,'sw.js'),'self.fixedOfficialWorker=true;\n');await mkdir(join(assets,'assets'));await writeFile(join(assets,'assets/main.js'),'window.fixedClient=true;\n');await writeFile(join(root,'private.cfg'),'private fixture');await symlink(join(root,'private.cfg'),join(assets,'outside.cfg'));
  const client=await productClientAssets(assets);server=createServer((q,r)=>{void client(q,r,new AbortController().signal,q.headers['x-test-auth']==='yes');});await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+(server.address() as any).port;
  const get=(path:string,authenticated=true,method='GET')=>new Promise<{code:number;body:string;headers:any}>((resolve,reject)=>{const req=httpRequest(url+path,{method,headers:{'x-test-auth':authenticated?'yes':'no'}},res=>{let text='';res.setEncoding('utf8');res.on('data',s=>text+=s);res.once('end',()=>resolve({code:res.statusCode!,body:text,headers:res.headers}));});req.once('error',reject);req.end();});
  const login=await get('/_client/login',false);assert.equal(login.code,200);assert(login.body.includes('autocomplete="current-password"'));assert(login.body.includes('Cycnumbris 500'));assert(!login.body.includes('localStorage'));assert.match(login.headers['content-security-policy'],/script-src 'nonce-/);
  const shell=await get('/_client/control');assert.equal(shell.code,200);assert(shell.body.includes('iframe src="/"'));assert(shell.body.includes('退出登录'));assert.equal(shell.headers['cache-control'],'no-store');
  assert(shell.body.includes('href="/_client/queue"'));
  const queue=await get('/_client/queue');assert.equal(queue.code,200);assert.equal(queue.headers['cache-control'],'no-store');assert.match(queue.headers['content-security-policy'],/script-src 'nonce-/);
  assert(queue.body.includes('确认并开始下一份'));assert(queue.body.includes('id="queue-cleared" type="checkbox" disabled'));assert(!queue.body.includes('<iframe'));assert(!queue.body.includes('localStorage'));assert.equal((await get('/_client/queue',false)).code,405);
  for(const route of ['/', '/files', '/console', '/history', '/config', '/settings/machine'])assert.equal((await get(route)).body,'<html>fixed official client</html>');assert(login.body.includes("window.location.replace('/_client/control')"));assert.equal((await get('/_client/control',false)).code,405);const js=await get('/assets/main.js');assert.equal(js.body,'window.fixedClient=true;\n');assert.equal(js.headers['content-type'],'text/javascript; charset=UTF-8');
  assert.equal((await get('/assets/main.js',true,'HEAD')).body,'');assert.equal((await get('/assets/main.js',false)).code,405);
  assert.equal((await get('/_client/upstream-worker.js')).body,'self.fixedOfficialWorker=true;\n');const worker=await get('/sw.js');assert.equal(worker.headers['service-worker-allowed'],'/');assert(worker.body.includes('event.stopImmediatePropagation()'));assert(worker.body.includes("importScripts('/_client/upstream-worker.js')"));assert(worker.body.includes('server|printer|machine|access|websocket'));assert.equal(worker.headers['cache-control'],'no-store');
  for(const path of ['/outside.cfg','/%2e%2e/private.cfg','/%5cprivate.cfg','//private.cfg','/missing.js'])assert.notEqual((await get(path)).code,200);
 }finally{if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
});
