import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {ApiKeyAuthorization} from '../src/moonraker/api-key-authorization.ts';
import {loadNativeProductMachineProfile} from '../src/runtime/native-product-machine.ts';
import {runProductHost} from '../src/runtime/product-host.ts';
import {productMachineFixture} from './helpers/product-machine.ts';
const authorization={issuer:'http://printer.test'};
type Fixture=Awaited<ReturnType<typeof productMachineFixture>>;
function options(f:Fixture,root:string,database:DatabaseStore,onRelease:()=>void){
 return {filesRoot:join(root,'files'),metadataRoot:join(root,'metadata'),createAdapter:async()=>({
  stops:f.bindings.stops,lifecycle:f.bindings.print.lifecycle,output:f.bindings.print.output,
  async authorizePrintFile(){},server:{information:f.bindings.server.information,database,authorization},
  async release(){onRelease();await database.close();}
 })};
}
test('native product rejects invalid authorization before MCU and journal acquisition, releasing the adapter database',async()=>{
 const root=await mkdtemp(join(tmpdir(),'product-auth-reject-')),f=await productMachineFixture(root);let releases=0;
 try{
  for(const mode of ['unsupported','mixed','closed','issuer']){
   const db=await DatabaseStore.open({path:join(root,mode+'.sqlite')}),config=options(f,root,db,()=>releases++);
   await writeFile(f.config.moonrakerConfig,'[server]\nhost: 127.0.0.1\nport: 0\n'+(mode==='unsupported'?'[authorization]\ntrusted_clients: 127.0.0.1\n':''));
   const factory=config.createAdapter;
   config.createAdapter=async()=>{const adapter=await factory();if(mode==='mixed')Object.assign(adapter.server,{authorize:()=>{}});if(mode==='issuer')adapter.server.authorization={issuer:'not-an-origin'};return adapter;};
   if(mode==='closed')await db.close();
   try{await assert.rejects(loadNativeProductMachineProfile(f.path,config,new AbortController().signal),mode==='unsupported'?/Unsupported/:mode==='mixed'?/external callbacks/:mode==='closed'?/open database/:/issuer/);
    assert.equal(db.status.closed,true);await assert.rejects(access(f.config.journalPath));assert.deepEqual(f.transport.stops,[0,0]);assert(f.transport.firmware.every(m=>m.stepperConfigs.length===0&&m.motion.length===0));
   }finally{await db.close();}
  }
  assert.equal(releases,4);
 }finally{await f.close();await rm(root,{recursive:true,force:true});}
});
test('native product owns login and authenticated printer state across service restart without external authorization callbacks',async()=>{
 const root=await mkdtemp(join(tmpdir(),'product-auth-live-')),path=join(root,'authorization.sqlite');let db=await DatabaseStore.open({path});let token='',key='',releases=0;
 try{
  const provision=await ApiKeyAuthorization.open(db,authorization);try{key=provision.localApiKey();}finally{await provision.close();await db.close();}
  for(let generation=0;generation<2;generation++){
   const f=await productMachineFixture(root),abort=new AbortController();db=await DatabaseStore.open({path});let failure:unknown,observed:Promise<void>|undefined;
   try{
    await runProductHost(s=>loadNativeProductMachineProfile(f.path,options(f,root,db,()=>releases++),s),abort.signal,address=>{
     observed=(async()=>{
      const url=`http://127.0.0.1:${address.port}`;
      const request=async(route:string,headers:Record<string,string>={},body?:object)=>{const response=await fetch(url+route,{headers:{'content-type':'application/json',...headers},method:body?'POST':'GET',body:body?JSON.stringify(body):undefined});return {status:response.status,body:await response.json() as any};};
      assert.equal((await request('/printer/print/status')).status,401);
      if(!generation){const created=await request('/access/user',{'x-api-key':key},{username:'operator',password:'test-password'});assert.equal(created.status,200);token=created.body.result.token;}
      const state=await request('/printer/print/status',{authorization:'Bearer '+token});assert.equal(state.status,200);assert.equal(state.body.result.state,'idle');
      const login=await request('/access/login',{}, {username:'operator',password:'test-password'});assert.equal(login.status,200);token=login.body.result.token;
      const info=await request('/server/info',{authorization:'Bearer '+token});assert.equal(info.status,200);assert(info.body.result.components.includes('authorization'));assert.deepEqual(info.body.result.registered_directories,['gcodes']);
      if(!generation){
       const issued=await request('/access/oneshot_token',{authorization:'Bearer '+token});assert.equal(issued.status,200);
       const form=()=>{const body=new FormData();body.append('file',new Blob(['G1 X1 F600\n']),'client.gcode');body.append('path','');body.append('root','gcodes');return body;};
       const urlWithToken=url+'/server/files/upload?token='+issued.body.result;
       const uploaded=await fetch(urlWithToken,{method:'POST',body:form()});assert.equal(uploaded.status,200);const receipt=(await uploaded.json() as any).result;
       assert.equal(receipt.action,'create_file');assert.equal(receipt.item.root,'gcodes');assert.equal(receipt.item.path,receipt.file.id+'.gcode');assert.equal(receipt.item.size,11);assert(receipt.item.modified>0);
       const replay=await fetch(urlWithToken,{method:'POST',body:form()});assert.equal(replay.status,401);await replay.arrayBuffer();
       const listing=await request('/server/files/list',{authorization:'Bearer '+token});assert.equal(listing.body.result.length,1);assert.equal(listing.body.result[0].path,receipt.item.path);
      }
      if(generation){assert.equal((await request('/access/logout',{authorization:'Bearer '+token},{})).status,200);assert.equal((await request('/printer/print/status',{authorization:'Bearer '+token})).status,401);}
     })().catch(error=>{failure=error;}).finally(()=>abort.abort(new Error('acceptance complete')));
    });await observed;if(failure)throw failure;
    assert.equal(db.status.closed,true);assert.equal(releases,generation+1);assert.deepEqual(f.transport.stops,[1,1]);assert(f.transport.firmware.every(m=>m.motion.length===0));
   }finally{abort.abort();await db.close();await f.close();}
  }
 }finally{await db.close();await rm(root,{recursive:true,force:true});}
});
