import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,rename,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MoonrakerHttpClient,HttpResponse,type HttpRequestOptions} from '../src/moonraker/http-client.ts';
import {WebDeployment,type WebDeploymentConfiguration} from '../src/moonraker/update-web-deploy.ts';
const signal=()=>new AbortController().signal;
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'update-web-')),calls:string[]=[];let body:unknown={tag_name:'v2',assets:[{name:'first.zip',browser_download_url:'https://example.invalid/first',content_type:'application/zip',size:10},{name:'client.zip',browser_download_url:'https://example.invalid/client',content_type:'application/zip',size:20}]},code=200,failed=false;
 class Client extends MoonrakerHttpClient {override async githubApiRequest(resource:string,options:Pick<HttpRequestOptions,'attempts'|'retryPauseTime'|'signal'|'requestTimeout'|'maxBodyBytes'|'redirect'>={}){calls.push(resource);assert.equal(options.maxBodyBytes,1048576);assert.equal(options.redirect,'error');options.signal?.throwIfAborted();if(failed)throw Error('Private network detail');return new HttpResponse('https://api.github.com/'+resource,'https://api.github.com/'+resource,code,body===null?Buffer.alloc(0):Buffer.from(JSON.stringify(body)),new Headers(),null);}}
 const client=new Client(),config:WebDeploymentConfiguration={name:'client',path:root,repo:'configured/repo',channel:'stable',channelInvalid:false,reportAnomalies:true,infoTags:['test'],refreshInterval:604800,configHash:'a'.repeat(64)};
 const owner=()=>new WebDeployment({...config},client),release=(extra:Record<string,unknown>={})=>writeFile(join(root,'release_info.json'),JSON.stringify({project_owner:'detected',project_name:'repo',version:'v1',asset_name:'client.zip',...extra}));
 return {root,calls,config,owner,release,setBody(value:unknown,status=200){body=value;code=status;},fail(){failed=true;},async close(){await client.close();await rm(root,{recursive:true,force:true});}};
}
test('web status reads actual release info and refresh selects the configured asset and rate-safe resource',async()=>{
 const f=await fixture();try{await f.release();const app=f.owner();await app.initialize(signal());assert.equal(app.status.is_valid,true);assert.equal(app.status.version,'v1');assert.equal(app.status.owner,'detected');assert.equal(app.status.rollback_version,'v1');assert.equal(f.calls.length,0);assert.equal((app.status.anomalies as string[]).length,1);
  await app.refresh(signal());assert.deepEqual(f.calls,['repos/detected/repo/releases/latest']);assert.equal(app.status.remote_version,'v2');assert.deepEqual(app.storage.dl_info,['https://example.invalid/client','application/zip',20]);assert(app.lastRefresh>0);
  f.setBody(null,304);await app.refresh(signal());assert.equal(app.status.remote_version,'v2');f.setBody({tag_name:'v3',assets:[]},304);await app.refresh(signal());assert.equal(app.status.remote_version,'v3');
 }finally{await f.close();}
});
test('release info requires actual string repository fields and never falls back when the file exists but is bad',async()=>{
 const f=await fixture();try{await writeFile(join(f.root,'manifest.json'),'\{"name":"mainsail"}');for(const key of ['project_owner','project_name'])for(const value of [undefined,null,4,'']){await f.release({[key]:value});const app=f.owner();await app.refresh(signal());assert.equal(app.status.is_valid,false);assert.equal(app.status.remote_version,'?');}await writeFile(join(f.root,'release_info.json'),'{broken');const app=f.owner();await app.refresh(signal());assert.equal(app.status.is_valid,false);assert.equal(f.calls.length,0);}finally{await f.close();}
});
test('web fallback accepts only the pinned client names and beta queries the first release',async()=>{
 const f=await fixture();try{f.config.channel='beta';f.setBody([{name:'beta2',assets:[]}]);await writeFile(join(f.root,'.version'),' v0 \n');await writeFile(join(f.root,'manifest.webmanifest'),'\{"name":"Mainsail"}');const app=f.owner();await app.refresh(signal());assert.equal(app.status.version,'v0');assert.equal(app.status.remote_version,'beta2');assert.deepEqual(f.calls,['repos/mainsail-crew/mainsail/releases?per_page=1']);await writeFile(join(f.root,'manifest.webmanifest'),'\{"name":"other"}');await app.refresh(signal());assert.equal(app.status.is_valid,false);assert.equal(f.calls.length,1);}finally{await f.close();}
});
test('repo changes and directory replacement cannot reattribute old remote or local versions after failure',async()=>{
 const f=await fixture();try{await f.release();const app=f.owner();await app.refresh(signal());assert.equal(app.status.remote_version,'v2');await f.release({project_owner:'new-owner',version:'v4'});f.fail();await app.refresh(signal());assert.equal(app.status.owner,'new-owner');assert.equal(app.status.remote_version,'?');assert.deepEqual(app.storage.dl_info,['?','?',0]);
  const old=f.root+'-old';await rename(f.root,old);try{await mkdir(f.root);await writeFile(join(f.root,'manifest.json'),'\{"name":"fluidd"}');await app.refresh(signal());assert.equal(app.status.version,'?');assert.equal(app.status.remote_version,'?');assert.equal(app.status.owner,'fluidd-core');}finally{await rm(old,{recursive:true,force:true});}
 }finally{await f.close();}
});
test('changed config hash discards saved state, and removing local version metadata never retains an old version',async()=>{
 const f=await fixture();try{await f.release();const app=f.owner();await app.refresh(signal());const saved=app.storage;f.config.configHash='b'.repeat(64);const reopened=f.owner();reopened.restore(saved);await reopened.initialize(signal());assert.equal(reopened.status.remote_version,'?');await rm(join(f.root,'release_info.json'));await writeFile(join(f.root,'manifest.json'),'\{"name":"mainsail"}');await app.initialize(signal());assert.equal(app.status.version,'?');}finally{await f.close();}
});
test('web installation inside a git checkout or oversized metadata does not contact the remote',async()=>{
 const f=await fixture();try{await f.release();await mkdir(join(f.root,'.git'));const app=f.owner();await app.refresh(signal());assert.equal(app.status.is_valid,false);await rm(join(f.root,'.git'),{recursive:true});await writeFile(join(f.root,'release_info.json'),' '.repeat(65537));await app.refresh(signal());assert.equal(app.status.is_valid,false);assert.equal(f.calls.length,0);}finally{await f.close();}
});
