import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,open,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {ApiKeyAuthorization} from '../src/moonraker/api-key-authorization.ts';
import {anonymousThumbnailGet} from '../src/moonraker/authorization-policy.ts';
import {NativePrintUploads} from '../src/moonraker/native-print-uploads.ts';
import {MoonrakerNetwork} from '../src/moonraker/server.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher,type Json} from '../src/moonraker/rpc.ts';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';

test('native image GET follows optional authentication across recovery without granting file or mutation access',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-thumbnail-auth-')),signal=new AbortController().signal;
 let now=10000,db:DatabaseStore|undefined,auth:ApiKeyAuthorization|undefined,files:PublishedPrintFiles|undefined,owner:NativePrintUploads|undefined,network:MoonrakerNetwork|undefined;
 const images:Array<{id:string;filename:string;path:string;bytes:Buffer}>=[];
 try{
  for(let generation=0;generation<2;generation++){
   db=await DatabaseStore.open({path:join(root,'auth.sqlite')});auth=await ApiKeyAuthorization.open(db,{issuer:'http://printer.test',now:()=>now,forceLogins:true,trustedClients:['127.0.0.1']});
   files=await PublishedPrintFiles.open(join(root,'files'));owner=await NativePrintUploads.open(files,new MaintenanceGate(),{metadataRoot:join(root,'metadata')});
   const rpc=new JsonRpcDispatcher(),endpoints=new EndpointRegistry(rpc);auth.register(endpoints);
   endpoints.register({endpoint:'/server/files/metadata',methods:['GET']},(params,_verb,context)=>owner!.metadata(params,context.signal));
   network=new MoonrakerNetwork(rpc,{endpoints,nativeUploads:owner,...auth.networkOptions});const address=await network.listen(),base=`http://127.0.0.1:${address.port}`;
   const access=async(action:string,body:object,token?:string)=>{const response=await fetch(base+'/access/'+action,{method:'POST',headers:{'content-type':'application/json',...token?{authorization:'Bearer '+token}:{'x-api-key':auth!.localApiKey()}},body:JSON.stringify(body)});assert.equal(response.status,200);return (await response.json() as any).result;};
   if(!generation){await access('user',{username:'operator',password:'fixture-only'});await files.mutateDirectory('零件 50%',false,signal);
    for(const format of ['png','jpg'] as const){
     const bytes=await sharp({create:{width:32,height:32,channels:3,background:'#3a6'}}).toFormat(format==='jpg'?'jpeg':'png').toBuffer(),data=bytes.toString('base64'),id='source-'+format,filename='零件 50%/'+format+'.gcode';
     const source=join(root,id);await writeFile(source,`; thumbnail_${format} begin 32x32 ${data.length}\n; ${data}\n; thumbnail_${format} end\nG1 X1\n`);const handle=await open(source,'r');try{await files.publish(id,format+'.gcode',handle,signal,filename);}finally{await handle.close();}
     const metadata=await owner.metadata({filename},signal),thumb=(metadata.thumbnails as Record<string,Json>[]).at(-1)!;
     const path='/server/files/gcodes/'+('零件 50%/'+thumb.relative_path).split('/').map(encodeURIComponent).join('/');images.push({id,filename,path,bytes});
    }
   }
   const login=await access('login',{username:'operator',password:'fixture-only'}),headers={authorization:'Bearer '+login.token};
   for(const image of images){
    const get=await fetch(base+image.path+'?date=1');assert.equal(get.status,200);assert.deepEqual(Buffer.from(await get.arrayBuffer()),image.bytes);assert.equal(get.headers.get('content-type'),image.path.endsWith('.jpg')?'image/jpeg':'image/png');
    const etag=get.headers.get('etag')!;const cached=await fetch(base+image.path,{headers:{'if-none-match':etag}});assert.equal(cached.status,304);await cached.arrayBuffer();
    for(const [method,status] of [['HEAD',401],['POST',405],['DELETE',405]] as const){const denied=await fetch(base+image.path,{method});assert.equal(denied.status,status);await denied.arrayBuffer();}
    const badCredentials:Record<string,string>[]=[{authorization:'Bearer invalid'},{'x-api-key':'invalid'},{origin:'https://untrusted.test'}];for(const badHeaders of badCredentials){const denied=await fetch(base+image.path,{headers:badHeaders});assert.equal(denied.status,badHeaders.origin?403:401);await denied.arrayBuffer();}
    const head=await fetch(base+image.path,{method:'HEAD',headers});assert.equal(head.status,200);assert.equal((await head.arrayBuffer()).byteLength,0);
    const fileUrl=base+'/server/files/gcodes/'+image.filename.split('/').map(encodeURIComponent).join('/');for(const method of ['GET','HEAD','DELETE']){const denied=await fetch(fileUrl,{method});assert.equal(denied.status,method==='DELETE'?405:401);await denied.arrayBuffer();}
    const metadata=await fetch(base+'/server/files/metadata?filename='+encodeURIComponent(image.filename));assert.equal(metadata.status,401);await metadata.arrayBuffer();
    const missing=await fetch(base+image.path.replace('0.','99.').replace('1.','99.'));assert.equal(missing.status,404);await missing.arrayBuffer();
   }
   now+=3601;const expired=await fetch(base+images[0].path,{headers});assert.equal(expired.status,200);await expired.arrayBuffer();
   const expiredMetadata=await fetch(base+'/server/files/metadata?filename='+encodeURIComponent(images[0].filename),{headers});assert.equal(expiredMetadata.status,401);await expiredMetadata.arrayBuffer();
   const refreshed=await access('refresh_jwt',{refresh_token:login.refresh_token});await access('logout',{},refreshed.token);
   const revoked=await fetch(base+images[0].path,{headers});assert.equal(revoked.status,401);await revoked.arrayBuffer();
   const anonymous=await fetch(base+images[0].path);assert.equal(anonymous.status,200);await anonymous.arrayBuffer();
   if(generation){for(const image of images){await files.remove(image.id,signal);const stale=await fetch(base+image.path);assert.equal(stale.status,404);await stale.arrayBuffer();}}
   await network.close();network=undefined;await owner.close();owner=undefined;await files.close();files=undefined;await auth.close();auth=undefined;await db.close();db=undefined;
  }
 }finally{await network?.close();await owner?.close();await files?.close();await auth?.close();await db?.close();await rm(root,{recursive:true,force:true});}
});

test('anonymous image eligibility rejects method, route, encoding and extension tricks',()=>{
 const path='/server/files/gcodes/零件 50%/.thumbs/thumb-12345678-1234-1234-1234-123456789abc/0.png',url=path.split('/').map(encodeURIComponent).join('/');assert(anonymousThumbnailGet({method:'GET',url:url+'?date=1'}));
 for(const method of ['HEAD','POST','DELETE','OPTIONS'])assert.equal(anonymousThumbnailGet({method,url}),false);
 for(const bad of [url.replace('/gcodes/','/config/'),url.replace('/0.png','/0.png.gcode'),url.replace('/0.png','/0.gif'),url.replace('/0.png','/00.png'),url.replace('/0.png','/%2e%2e%2f0.png'),url.replace('/0.png','/%00.png'),url+'%ZZ',url.replace('/.thumbs/','/%2e%2e/.thumbs/')])assert.equal(anonymousThumbnailGet({method:'GET',url:bad}),false,bad);
});
