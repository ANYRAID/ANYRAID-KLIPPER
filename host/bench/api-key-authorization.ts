import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {IncomingMessage} from 'node:http';
import {Socket} from 'node:net';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {ApiKeyAuthorization} from '../src/moonraker/api-key-authorization.ts';
const root=await mkdtemp(join(tmpdir(),'auth-bench-')),database=await DatabaseStore.open({path:join(root,'auth.sqlite')}),auth=await ApiKeyAuthorization.open(database),socket=new Socket(),request=new IncomingMessage(socket);
try{
 const route=process.env.ANYRAID_AUTH_BENCH_ROUTE??'status';assert(['status','file','image','anonymous-image'].includes(route));request.method='GET';request.url=route==='status'?'/server/info':route==='file'?'/server/files/gcodes/parts/50%25%20test.gcode':'/server/files/gcodes/parts/.thumbs/thumb-12345678-1234-1234-1234-123456789abc/0.png?date=1';
 if(route!=='anonymous-image')request.headers['x-api-key']=auth.localApiKey();const method=route==='status'?'server.info':'server.files.download',context={request,transport:'http' as const,signal:new AbortController().signal},samplesMs:number[]=[];let accepted=0;
 for(let round=0;round<8;round++){const start=performance.now();for(let i=0;i<100000;i++){const result=auth.authorize(method,{},context);if(route==='anonymous-image'?result===undefined:result?.username==='_API_KEY_USER_')accepted++;}if(round>=3)samplesMs.push(performance.now()-start);}
 assert.equal(accepted,800000);const medianMs=[...samplesMs].sort((a,b)=>a-b)[2],microsecondsPerRequest=medianMs/100;
 assert(microsecondsPerRequest<10,'API key authorization exceeds 10 microseconds per request');
 console.log(JSON.stringify({runtime:process.version,route,scope:'100000 HTTP authentications per round; 3 warmups and 5 retained rounds; includes live owner checks, request route policy and credential processing; excludes sockets and IO; not a Python comparison',samplesMs,medianMs,microsecondsPerRequest,maximumMicrosecondsPerRequest:10},null,2));
}finally{socket.destroy();await auth.close();await database.close();await rm(root,{recursive:true,force:true});}
