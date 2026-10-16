import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {createHash} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {productClientAssets} from '../src/runtime/product-client-assets.ts';
const origin='http://127.0.0.1:18420',suffix=createHash('md5').update(origin).digest('hex');
const credentialKeys=['user-token-'+suffix,'refresh-token-'+suffix];

async function emitted(path:string){
 const root=await mkdtemp(join(tmpdir(),'login-worker-script-'));
 try{
  await writeFile(join(root,'index.html'),'fixed client');const client=await productClientAssets(root,origin);let body='';
  await client({url:path,method:'GET'} as IncomingMessage,{setHeader(){},writeHead(){},end(value:string){body=value;}} as unknown as ServerResponse,new AbortController().signal,false);
  return path==='/sw.js'?body:/<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(body)![1];
 }finally{await rm(root,{recursive:true,force:true});}
}
async function browser(serviceWorker:unknown,options:{loginStatus?:number;storageFailure?:boolean}={}){
 let submit:()=>Promise<void>=()=>Promise.reject(Error('Missing submit handler')),requests=0,resets=0;const redirects:string[]=[],timers=new Map<number,()=>void>();let nextTimer=0;
 const button={disabled:false,textContent:''},error={textContent:''},form={querySelector:()=>button,addEventListener(_name:string,handler:(e:unknown)=>Promise<void>){submit=()=>handler({preventDefault(){}});},reset(){resets++;}};
 const storage=new Map([...credentialKeys.map(key=>[key,'stale-fixture-credential'] as const),['user-token-other-printer','other-fixture-credential'],['refresh-token-other-printer','other-fixture-refresh'],['fluidd-local-instances','fixture-printer-preference'],['theme','dark']]),removed:string[]=[];
 runInNewContext(await emitted('/access/client-login'),{document:{querySelector:(selector:string)=>selector==='form'?form:error},navigator:{serviceWorker},window:{location:{origin,replace:(url:string)=>redirects.push(url)}},localStorage:{removeItem(key:string){if(options.storageFailure)throw Error('Storage blocked');removed.push(key);storage.delete(key);},clear(){throw Error('Must preserve preferences and other printers');}},FormData:class {get(name:string){return name==='username'?'fixture-user':'fixture-only';}},fetch:async()=>{requests++;const status=options.loginStatus??200;return {ok:status===200,status};},setTimeout:(callback:()=>void,ms:number)=>{assert.equal(ms,5000);const id=++nextTimer;timers.set(id,callback);return id;},clearTimeout:(id:number)=>timers.delete(id)});
 return {submit:()=>submit(),button,error,redirects,timers,storage,removed,requests:()=>requests,resets:()=>resets};
}
test('worker migration never fetches cached content, erases preferences or navigates other printing windows',async()=>{
 const listeners=new Map<string,(event:unknown)=>void>();let skipped=0,claimed=0;const waits:Promise<unknown>[]=[];
 runInNewContext(await emitted('/sw.js'),{self:{addEventListener:(name:string,handler:(event:unknown)=>void)=>listeners.set(name,handler),skipWaiting:async()=>{skipped++;},clients:{claim:async()=>{claimed++;},matchAll(){throw Error('Must not reload other clients');}}}});
 assert.equal(listeners.has('fetch'),false);listeners.get('install')!({waitUntil:(promise:Promise<unknown>)=>waits.push(promise)});listeners.get('activate')!({waitUntil:(promise:Promise<unknown>)=>waits.push(promise)});await Promise.all(waits);assert.equal(skipped,1);assert.equal(claimed,1);
});
test('login remains withheld until the replacement worker activates, then submits exactly once',async()=>{
 let changed:()=>void=()=>{},removed=0,registered=0,updated=0;
 const worker={state:'installing',addEventListener(_name:string,handler:()=>void){changed=handler;},removeEventListener(){removed++;}};
 const f=await browser({controller:{},register:async(url:string,options:{scope:string;updateViaCache:string})=>{assert.equal(url,'/sw.js');assert.equal(options.scope,'/');assert.equal(options.updateViaCache,'none');registered++;return {installing:worker,update:async()=>{updated++;}};}});
 const submitting=f.submit();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.requests(),0);assert.equal(f.button.disabled,true);assert.equal(f.redirects.length,0);worker.state='activated';changed();await submitting;
 assert.equal(registered,1);assert.equal(updated,1);assert.equal(removed,1);assert.equal(f.timers.size,0);assert.equal(f.requests(),1);assert.equal(f.resets(),1);assert.deepEqual(f.redirects,['/_client/control']);
});
test('stalled worker update reaches the fixed deadline without transmitting login credentials or retrying',async()=>{
 let registrations=0;const f=await browser({controller:{},register:()=>{registrations++;return new Promise(()=>{});}});
 const submitting=f.submit();assert.equal(f.timers.size,1);for(const callback of [...f.timers.values()])callback();await submitting;
 assert.equal(f.requests(),0);assert.equal(f.resets(),0);assert.equal(f.redirects.length,0);assert.equal(f.button.disabled,false);assert.equal(f.timers.size,0);assert.match(f.error.textContent,/重新加载/);await f.submit();assert.equal(registrations,1);assert.equal(f.requests(),0);
});
test('fresh browsers without a controlling worker submit through native login without migration delays',async()=>{
 const f=await browser(undefined);await f.submit();assert.equal(f.requests(),1);assert.equal(f.timers.size,0);assert.deepEqual(f.redirects,['/_client/control']);
});
test('successful managed login removes only this printer credential pair before client navigation',async()=>{
 const f=await browser(undefined);await f.submit();assert.deepEqual(f.removed,credentialKeys);for(const key of credentialKeys)assert.equal(f.storage.has(key),false);
 assert.equal(f.storage.get('user-token-other-printer'),'other-fixture-credential');assert.equal(f.storage.get('refresh-token-other-printer'),'other-fixture-refresh');assert.equal(f.storage.get('fluidd-local-instances'),'fixture-printer-preference');assert.equal(f.storage.get('theme'),'dark');assert.deepEqual(f.redirects,['/_client/control']);
});
test('rejected login preserves all existing credentials and preferences without client navigation',async()=>{
 const f=await browser(undefined,{loginStatus:401});await f.submit();assert.equal(f.requests(),1);assert.deepEqual(f.removed,[]);for(const key of credentialKeys)assert(f.storage.has(key));assert.deepEqual(f.redirects,[]);assert.match(f.error.textContent,/账号或密码/);
});
test('unavailable browser storage keeps the official client closed after login instead of reusing stale credentials',async()=>{
 const f=await browser(undefined,{storageFailure:true});await f.submit();assert.equal(f.requests(),1);assert.equal(f.resets(),1);assert.deepEqual(f.redirects,[]);assert.deepEqual(f.removed,[]);assert.match(f.error.textContent,/旧登录凭据/);assert.equal(f.button.disabled,false);
});
