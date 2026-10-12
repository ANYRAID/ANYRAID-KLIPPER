import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import filesystem,{mkdtemp,readFile,writeFile,rm,readdir,symlink} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {gzipSync} from 'node:zlib';
import {MoonrakerHttpClient,HttpResponse} from '../src/moonraker/http-client.ts';
import {ApiError} from '../src/moonraker/rpc.ts';
async function peer(run:(req:IncomingMessage,res:ServerResponse)=>void|Promise<void>){
 const server=createServer((req,res)=>{Promise.resolve(run(req,res)).catch(()=>{res.destroy();});});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const info=server.address();assert(info&&typeof info==='object');
 return {url:'http://127.0.0.1:'+info.port,close:()=>new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();})};
}
test('HTTP wire headers, JSON body, basic auth and prepared request wrapper match pinned semantics',async()=>{
 const received:{method:string;url:string;headers:IncomingMessage['headers'];body:string}[]=[];
 const server=await peer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;received.push({method:req.method!,url:req.url!,headers:req.headers,body});res.setHeader('content-type','application/json');res.end('{"ok":true,"coordinate":-0}');}),client=new MoonrakerHttpClient();
 try{
  const response=await client.post(server.url+'/body',{nested:[1,'text'],coordinate:-0},{headers:{'Content-Type':'wrong'},basicAuthUser:'fixture',basicAuthPass:'synthetic'});assert.equal(response.statusCode,200);assert.equal(response.hasError(),false);assert(Object.is((response.json() as {coordinate:number}).coordinate,-0));
  assert.equal(received[0].headers['content-type'],'application/json');assert.equal(received[0].headers['user-agent'],'Moonraker');assert.equal(received[0].headers.authorization,'Basic '+Buffer.from('fixture:synthetic').toString('base64'));assert.deepEqual(JSON.parse(received[0].body),{nested:[1,'text'],coordinate:-0});
  const wrapper=client.wrapRequest(server.url+'/default',{method:'POST',body:{value:1},headers:{'X-Mode':'original'}});wrapper.setUrl(server.url+'/next');wrapper.setBody({value:2});wrapper.addHeader('X-Mode','changed');assert.equal((await wrapper.send()).statusCode,200);assert.equal(wrapper.lastResponse()!.statusCode,200);
  wrapper.reset();await wrapper.send();assert.equal(received[1].url,'/next');assert.equal(received[1].headers['x-mode'],'changed');assert.equal(received[2].url,'/default');assert.equal(received[2].headers['x-mode'],'original');assert.equal(received[2].body,'{"value":1}');
  wrapper.setMethod('DELETE');await wrapper.send({body:null});assert.equal(received[3].method,'DELETE');
 }finally{await client.close();await server.close();}
});
test('HTTP cache uses query-free keys and original conditional/304 invalidation rules without mutable byte aliases',async()=>{
 const headers:IncomingMessage['headers'][]=[];let requests=0;const server=await peer((req,res)=>{headers.push(req.headers);requests++;if(requests===2){res.writeHead(304,{etag:'"v1"','last-modified':'Wed, 07 Oct 2026 01:02:03 GMT'});res.end();}else{res.writeHead(200,{etag:'"v1"','last-modified':'Wed, 07 Oct 2026 01:02:03 GMT'});res.end('original');}}),client=new MoonrakerHttpClient();
 try{
  const first=await client.get(server.url+'/cache?first=1');first.content.fill(0);first.headers.set('etag','poison');assert.equal(first.text,'original');
  const second=await client.get(server.url+'/cache?second=2');assert.equal(second.statusCode,304);assert.equal(second.text,'original');second.raiseForStatus();assert.equal(headers[1]['if-none-match'],'"v1"');assert.equal(headers[1]['if-modified-since'],'Wed, 07 Oct 2026 01:02:03 GMT');
  await client.get(server.url+'/cache',{sendEtag:false});assert.equal(headers[2]['if-none-match'],undefined);assert.equal(headers[2]['if-modified-since'],undefined);
  await client.get(server.url+'/cache',{sendIfModifiedSince:false,headers:{'If-None-Match':'caller'}});assert.equal(headers[3]['if-none-match'],'"v1"');assert.equal(headers[3]['if-modified-since'],undefined);
  await client.get(server.url+'/cache',{enableCache:false});assert.equal(client.status.cacheEntries,0);
  client.registerCachedUrl(server.url+'/cached','"seed"');assert.equal(client.status.cacheEntries,1);assert.throws(()=>client.registerCachedUrl(server.url+'/empty'),/Either/);
 }finally{await client.close();await server.close();}
});
test('unseeded 304 is successful and a 304 without validators evicts the prior cached record',async()=>{
 let seen=0;const server=await peer((_req,res)=>{if(seen++===1){res.setHeader('etag','v');res.end('bytes');}else{res.writeHead(304);res.end();}}),client=new MoonrakerHttpClient();
 try{const empty=await client.get(server.url);assert.equal(empty.statusCode,304);assert.equal(empty.byteLength,0);assert.equal(empty.error,null);await client.get(server.url);assert.equal(client.status.cacheEntries,1);assert.equal((await client.get(server.url)).text,'bytes');assert.equal(client.status.cacheEntries,0);}finally{await client.close();await server.close();}
});
test('status retries preserve the last HTTP response, thrown transport errors yield a bounded error response',async()=>{
 let seen=0;const server=await peer((_req,res)=>{seen++;res.writeHead(seen<3?503:200);res.end(seen<3?'retry':'ok');}),client=new MoonrakerHttpClient();
 try{
  const response=await client.get(server.url,{attempts:3,retryPauseTime:0});assert.equal(response.text,'ok');assert.equal(seen,3);
  const gone=await peer((_req,res)=>{res.end();});const url=gone.url;await gone.close();const transport=await client.get(url);assert.equal(transport.statusCode,500);assert(transport.hasError());assert.throws(()=>transport.raiseForStatus(),error=>error instanceof ApiError&&error.status===500);
 }finally{await client.close();await server.close();}
});
test('request deadline bounds stalled bodies and unsafe JSON cannot become null on the wire',async()=>{
 const server=await peer((_req,res)=>{res.writeHead(200);res.write('stalled');}),client=new MoonrakerHttpClient();try{const start=performance.now(),response=await client.get(server.url,{requestTimeout:.02});assert(response.hasError());assert.equal(response.statusCode,500);assert(performance.now()-start<1500);assert.throws(()=>response.raiseForStatus('private failure'),/private failure/);await assert.rejects(client.post(server.url,{value:NaN}),/JSON/);await assert.rejects(client.post(server.url,{value:Infinity}),/JSON/);}finally{await client.close();await server.close();}
});
test('HTTP redirect policy rejects loops and removes cross-origin credentials while retaining final URL',async()=>{
 let auth:string|undefined,cookie:string|undefined;const destination=await peer((req,res)=>{auth=req.headers.authorization;cookie=req.headers.cookie;res.end('redirected');});let source:string;const origin=await peer((req,res)=>{res.writeHead(302,{location:req.url==='/loop'?source+'/loop':destination.url+'/done'});res.end();});source=origin.url;const client=new MoonrakerHttpClient();
 try{const response=await client.get(origin.url,{headers:{Cookie:'synthetic=1'},basicAuthUser:'fixture',basicAuthPass:'synthetic'});assert.equal(response.finalUrl,destination.url+'/done');assert.equal(response.text,'redirected');assert.equal(auth,undefined);assert.equal(cookie,undefined);assert((await client.get(origin.url,{redirect:'error'})).hasError());assert((await client.get(origin.url+'/loop')).hasError());}finally{await client.close();await origin.close();await destination.close();}
});
test('response decoding preserves BOM/Latin-1 and rejects malformed UTF-8, unsafe integers and nonfinite JSON',()=>{
 const make=(bytes:Uint8Array)=>new HttpResponse('/synthetic','/synthetic',200,bytes,new Headers(),null);
 assert.equal(make(Buffer.from('\ufeffdata')).text,'\ufeffdata');assert.deepEqual(make(Buffer.from('\ufeff{"ok":true}')).json(),{ok:true});const latin=make(Buffer.from([0x80,0xff]));latin.encoding='latin-1';assert.equal(latin.text,'\x80\xff');latin.encoding='ascii';assert.throws(()=>latin.text);assert.throws(()=>make(Buffer.from([0xff])).text);
 for(const text of ['{"value":9007199254740993}','{"value":1e400}'])assert.throws(()=>make(Buffer.from(text)).json(),/range/);assert.deepEqual(make(Buffer.from('{"value":"9007199254740993"}')).json(),{value:'9007199254740993'});
});
test('compressed bodies and cached bodies obey decoded byte capacity; file helper throws response failures',async()=>{
 const server=await peer((req,res)=>{if(req.url==='/failure'){res.writeHead(404);res.end('missing');return;}const bytes=gzipSync(Buffer.alloc(4096,65));res.writeHead(200,{'content-encoding':'gzip','content-length':bytes.length,etag:'large'});res.end(bytes);}),client=new MoonrakerHttpClient();
 try{assert.equal((await client.get(server.url)).byteLength,4096);const bounded=await client.get(server.url,{maxBodyBytes:128});assert(bounded.hasError());assert.equal(client.status.cacheEntries,0);assert.equal((await client.getFile(server.url,'application/octet-stream')).length,4096);await assert.rejects(client.getFile(server.url+'/failure','application/octet-stream'),error=>error instanceof ApiError&&error.status===404);}finally{await client.close();await server.close();}
});
test('client close and caller cancellation abort body streams, retry waits and new admissions',async()=>{
 let opened:()=>void=()=>{};const ready=new Promise<void>(resolve=>opened=resolve),server=await peer((_req,res)=>{res.writeHead(200);res.write('start');opened();}),client=new MoonrakerHttpClient();
 try{const pending=client.get(server.url);await ready;const rejected=assert.rejects(pending,/closed/);const close=client.close();assert.equal(close,client.close());await close;await rejected;assert.equal(client.status.pending,0);await assert.rejects(client.get(server.url),error=>error instanceof ApiError&&error.status===503);}finally{await client.close();await server.close();}
 const other=await peer((_req,res)=>{res.writeHead(503);res.end();}),second=new MoonrakerHttpClient(),cancel=new AbortController();
 try{const retry=second.get(other.url,{attempts:3,retryPauseTime:10,signal:cancel.signal});const done=assert.rejects(retry,error=>error===cancel.signal.reason||error instanceof Error&&error.cause===cancel.signal.reason);await new Promise(resolve=>setTimeout(resolve,20));cancel.abort(new Error('caller cancelled'));await done;}finally{await second.close();await other.close();}
});
test('streaming download writes exact bytes, progress, UTF-8 filenames and atomic trusted destinations',async()=>{
 let auth:string|undefined;const bytes=Buffer.alloc(256*1024,0x5a),server=await peer((req,res)=>{auth=req.headers.authorization;res.writeHead(200,{'content-length':bytes.length,'content-disposition':"attachment; filename=plain.bin; filename*=utf-8''%E6%96%87%E4%BB%B6.bin"});res.end(bytes);}),client=new MoonrakerHttpClient(),root=await mkdtemp(join(tmpdir(),'http-download-'));let generated:string|undefined;
 try{const progress:number[]=[],path=join(root,'existing.bin');await writeFile(path,'old');assert.equal(await client.downloadFile(server.url,'application/octet-stream',{destinationPath:path,progress:percent=>progress.push(percent),basicAuthUser:'fixture',basicAuthPass:'synthetic'}),path);assert.equal(auth,'Basic '+Buffer.from('fixture:synthetic').toString('base64'));assert.deepEqual(await readFile(path),bytes);assert.equal(progress.at(-1),100);assert(progress.every((value,i)=>i===0||value>progress[i-1]));assert.deepEqual(await readdir(root),['existing.bin']);generated=await client.downloadFile(server.url,'application/octet-stream');assert.equal(generated.split('/').at(-1),'文件.bin');assert.deepEqual(await readFile(generated),bytes);}finally{await client.close();await server.close();await rm(root,{recursive:true,force:true});if(generated)await rm(dirname(generated),{recursive:true,force:true});}
});
test('failed downloads keep prior destinations and reject escaped filenames or symlink destinations',async()=>{
 const root=await mkdtemp(join(tmpdir(),'http-download-')),path=join(root,'file');await writeFile(path,'old');const server=await peer((req,res)=>{if(req.url==='/escape')res.setHeader('content-disposition','attachment; filename="../outside"');res.end(Buffer.alloc(256));}),client=new MoonrakerHttpClient();
 try{await assert.rejects(client.downloadFile(server.url,'application/octet-stream',{destinationPath:path,maxBodyBytes:16}));assert.equal((await readFile(path)).toString(),'old');await symlink('file',join(root,'link'));await assert.rejects(client.downloadFile(server.url,'application/octet-stream',{destinationPath:join(root,'link')}),/destination/);assert.equal((await readFile(path)).toString(),'old');await assert.rejects(client.downloadFile(server.url+'/escape','application/octet-stream'),/filename/);assert.deepEqual((await readdir(root)).sort(),['file','link']);}finally{await client.close();await server.close();await rm(root,{recursive:true,force:true});}
});
test('GitHub wrapper records rate headers, blocks exhausted limits before request and keeps nonnumeric headers invalid',async()=>{
 class Stub extends MoonrakerHttpClient {calls=0;received='';override async get(url:string){this.calls++;this.received=url;return new HttpResponse(url,url,200,Buffer.from('{}'),new Headers({'x-ratelimit-limit':'60','x-ratelimit-remaining':'0','x-ratelimit-reset':String(Date.now()/1000+60)}),null);}}
 const client=new Stub();try{assert.deepEqual(client.githubApiStats(),{github_rate_limit:null,github_requests_remaining:null,github_limit_reset_time:null});await client.githubApiRequest('/repos/example/project/');assert.equal(client.received,'https://api.github.com/repos/example/project');assert.equal(client.githubApiStats().github_requests_remaining,0);await assert.rejects(client.githubApiRequest('repos/example/project'),/Rate Limit/);assert.equal(client.calls,1);}finally{await client.close();}
});
test('HTTP pending capacity is bounded and shutdown aborts queued and active socket requests',async()=>{
 const server=await peer((_req,res)=>{res.writeHead(200);res.write('pending');}),client=new MoonrakerHttpClient();try{
  const work=Array.from({length:32},()=>client.get(server.url)),rejected=work.map(p=>assert.rejects(p,/closed/));assert.equal(client.status.pending,32);await assert.rejects(client.get(server.url),error=>error instanceof ApiError&&error.status===503);await client.close();await Promise.all(rejected);assert.equal(client.status.pending,0);
 }finally{await client.close();await server.close();}
});
test('cancelled streaming downloads clean only their private staging files and keep the existing destination',async()=>{
 const root=await mkdtemp(join(tmpdir(),'http-cancel-')),path=join(root,'existing');await writeFile(path,'old');const cancel=new AbortController(),server=await peer((_req,res)=>{res.writeHead(200,{'content-length':262144});res.write(Buffer.alloc(65536));const timer=setTimeout(()=>res.end(Buffer.alloc(196608)),100);res.once('close',()=>clearTimeout(timer));}),client=new MoonrakerHttpClient();
 try{await assert.rejects(client.downloadFile(server.url,'application/octet-stream',{destinationPath:path,signal:cancel.signal,progress:()=>cancel.abort(new Error('download cancelled'))}),/download cancelled/);assert.equal((await readFile(path)).toString(),'old');assert.deepEqual(await readdir(root),['existing']);}finally{await client.close();await server.close();await rm(root,{recursive:true,force:true});}
});
test('post-commit staging cleanup failure records a diagnostic without misreporting or retrying an already committed download',async t=>{
 const root=await mkdtemp(join(tmpdir(),'http-committed-')),path=join(root,'file');await writeFile(path,'old');let requests=0;const server=await peer((_req,res)=>{requests++;res.end('complete');}),client=new MoonrakerHttpClient(),original=filesystem.rm;
 t.mock.method(filesystem,'rm',async(...args:Parameters<typeof filesystem.rm>)=>{if(String(args[0]).startsWith(join(root,'.moonraker-download-')))throw new Error('synthetic post-commit cleanup fault');return original(...args);});syncBuiltinESMExports();
 try{assert.equal(await client.downloadFile(server.url,'application/octet-stream',{destinationPath:path,attempts:2,retryPauseTime:0}),path);assert.equal((await readFile(path)).toString(),'complete');assert.equal(requests,1);assert.equal(client.status.downloadCleanupFailures,1);assert.equal(client.status.pending,0);}finally{t.mock.restoreAll();syncBuiltinESMExports();await client.close();await server.close();await rm(root,{recursive:true,force:true});}
});
