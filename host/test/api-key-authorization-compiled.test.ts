import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {buildProductHost} from '../scripts/build-product-host.ts';
import {installProductDependencies} from './helpers/product-install.ts';
test('compiled native authorization serves HTTP without Python or TypeScript loading',async(t)=>{
 const root=await mkdtemp(join(tmpdir(),'compiled-auth-')),app=join(root,'app');
 try{
  await buildProductHost(app);await installProductDependencies(app);
  const module=(name:string)=>JSON.stringify(pathToFileURL(join(app,'host/src/moonraker',name+'.js')).href);
  const config=join(root,'moonraker.conf');await writeFile(config,'[server]\nhost: 127.0.0.1\nport: 0\n');
  const script=join(root,'check.mjs');await writeFile(script,`import assert from 'node:assert/strict';
import {DatabaseStore} from ${module('database')};
import {ApiKeyAuthorization} from ${module('api-key-authorization')};
import {ConfiguredMoonraker} from ${module('configured-server')};
const database=await DatabaseStore.open({path:${JSON.stringify(join(root,'auth.sqlite'))}}),auth=await ApiKeyAuthorization.open(database,{issuer:'http://compiled-printer.test'});
const server=await ConfiguredMoonraker.load(${JSON.stringify(config)},{information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'compiled-auth',missingRequirements:[]},...auth.networkOptions});
auth.register(server.endpoints);
try{const address=await server.start(),url='http://127.0.0.1:'+address.port;
const denied=await fetch(url+'/server/info');assert.equal(denied.status,401);await denied.arrayBuffer();
const key=auth.localApiKey(),headers={'x-api-key':key},times=[];
for(let i=0;i<250;i++){const start=performance.now(),r=await fetch(url+'/server/info',{headers});assert.equal(r.status,200);await r.arrayBuffer();if(i>=50)times.push(performance.now()-start);}
times.sort((a,b)=>a-b);assert(times[198]<50,'Authorized status P99 exceeds 50 ms');
const r=await fetch(url+'/access/api_key',{method:'POST',headers});assert.equal(r.status,200);const next=(await r.json()).result;assert.notEqual(next,key);
const old=await fetch(url+'/server/info',{headers});assert.equal(old.status,401);await old.arrayBuffer();
const fresh=await fetch(url+'/server/info',{headers:{'x-api-key':next}});assert.equal(fresh.status,200);await fresh.arrayBuffer();
const post=async(path,body,headers={})=>{const response=await fetch(url+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
const created=await post('/access/user',{username:'compiled-user',password:'compiled-password'},{'x-api-key':next});assert.equal(created.status,200);
const login=await post('/access/login',{username:'compiled-user',password:'compiled-password'});assert.equal(login.status,200);const token=login.body.result.token;
const jwtTimes=[];for(let i=0;i<250;i++){const start=performance.now(),r=await fetch(url+'/server/info',{headers:{authorization:'Bearer '+token}});assert.equal(r.status,200);await r.arrayBuffer();if(i>=50)jwtTimes.push(performance.now()-start);}
jwtTimes.sort((a,b)=>a-b);assert(jwtTimes[198]<50,'JWT status P99 exceeds 50 ms');
const refreshed=await post('/access/refresh_jwt',{refresh_token:login.body.result.refresh_token});assert.equal(refreshed.status,200);
const logout=await post('/access/logout',{}, {authorization:'Bearer '+token});assert.equal(logout.status,200);
const revoked=await post('/access/refresh_jwt',{refresh_token:login.body.result.refresh_token});assert.equal(revoked.status,401);
console.log(JSON.stringify({compiled:true,jwtLifecycle:true,jwtStatusP99Ms:jwtTimes[198],unauthorizedRejected:true,rotationRevokesOldKey:true,statusRequests:200,statusP99Ms:times[198],scope:'Sequential local HTTP requests; no physical MCU or concurrent printing'}));
}finally{await server.close();await auth.close();await database.close();}`);
  const result=JSON.parse(execFileSync(process.execPath,[script],{env:{...process.env,PATH:'/no-programs',NODE_PATH:'',NODE_OPTIONS:'--no-experimental-strip-types',NODE_DISABLE_COMPILE_CACHE:'1'},encoding:'utf8',timeout:30000}));assert.equal(result.compiled,true);t.diagnostic(JSON.stringify(result));
 }finally{await rm(root,{recursive:true,force:true});}
});
