import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createServer,request,Agent} from 'node:http';
import {pipeline} from 'node:stream/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import sharp from 'sharp';
import {ThumbnailStorage,publishThumbnailMetadata} from '../src/moonraker/thumbnail-storage.ts';
import {ThumbnailDownloads} from '../src/moonraker/thumbnail-download.ts';
import {FileMetadataStore} from '../src/moonraker/file-metadata.ts';
import {MoonrakerNetwork} from '../src/moonraker/server.ts';
import {JsonRpcDispatcher,ApiError} from '../src/moonraker/rpc.ts';
const stats=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[Math.floor(v.length/2)],p95Ms:v[Math.ceil(v.length*.95)-1]};};
const dir=await mkdtemp(join(tmpdir(),'thumbnail-http-bench-')),agent=new Agent({keepAlive:true,maxSockets:1});
let storage:ThumbnailStorage|undefined,network:MoonrakerNetwork|undefined,plain:ReturnType<typeof createServer>|undefined;
try{
 const raw=Buffer.alloc(768*512*3);let seed=42;for(let i=0;i<raw.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;raw[i]=seed>>>24;}
 const large=await sharp(raw,{raw:{width:768,height:512,channels:3}}).png().toBuffer(),small=await sharp(large).resize(32,32,{fit:'fill'}).png().toBuffer();
 const images=[{width:32,height:32,format:'png' as const,miniature:true,bytes:small},{width:768,height:512,format:'png' as const,miniature:false,bytes:large}];
 storage=await ThumbnailStorage.open(join(dir,'store'));const metadata=new FileMetadataStore(),id=ThumbnailStorage.newId();await publishThumbnailMetadata(storage,metadata,metadata.begin('part.gcode'),{},id,images,new AbortController().signal);
 // Stress the owner lookup with a full cache, using distinct generated references.
 for(let i=1;i<4096;i++)metadata.commit(metadata.begin(`other/${i}.gcode`),{thumbnails:[{relative_path:`.thumbs/${ThumbnailStorage.newId()}/0.png`,size:100}]});
 for(let i=0;i<images.length;i++)await writeFile(join(dir,`${i}.png`),images[i].bytes);const concurrent=join(dir,'print-read.bin');await writeFile(concurrent,Buffer.alloc(65536));
 network=new MoonrakerNetwork(new JsonRpcDispatcher(),{thumbnails:new ThumbnailDownloads(storage,metadata),authorize(_m,_p,{request}){if(request.headers['x-api-key']!=='key')throw new ApiError(401,'Unauthorized');}});
 const address=await network.listen();plain=createServer((req,res)=>{if(req.headers['x-api-key']!=='key'){res.writeHead(401).end();return;}const index=req.url==='/0.png'?0:req.url==='/1.png'?1:-1;if(index<0){res.writeHead(404).end();return;}res.setHeader('content-length',images[index].bytes.length);res.setHeader('content-type','image/png');void pipeline(createReadStream(join(dir,`${index}.png`)),res).catch(()=>res.destroy());});
 await new Promise<void>(resolve=>plain!.listen(0,'127.0.0.1',resolve));const plainPort=(plain.address() as import('node:net').AddressInfo).port;
 async function get(port:number,path:string,expected:Buffer,verify=false){await new Promise<void>((resolve,reject)=>{const req=request({host:'127.0.0.1',port,path,agent,headers:{'x-api-key':'key'}},res=>{let length=0;const chunks:Buffer[]=[];res.on('data',chunk=>{length+=chunk.length;if(verify)chunks.push(chunk);});res.on('error',reject);res.on('end',()=>{try{assert.equal(res.statusCode,200);assert.equal(length,expected.length);if(verify)assert.deepEqual(Buffer.concat(chunks),expected);resolve();}catch(error){reject(error);}});});req.on('error',reject);req.end();});}
 const results=[];
 for(const [index,calls] of [[0,100],[1,10]])for(const mode of ['thumbnail','plain-file-reference']){
  const port=mode==='thumbnail'?address.port:plainPort,path=mode==='thumbnail'?`/server/files/gcodes/.thumbs/${id}/${index}.png`:`/${index}.png`,expected=images[index].bytes;
  await get(port,path,expected,true);for(let i=0;i<5;i++)for(let n=0;n<calls;n++)await get(port,path,expected);
  const loop=monitorEventLoopDelay({resolution:1}),reads:number[]=[],samples:number[]=[];let stop=false;loop.enable();const reader=(async()=>{while(!stop){const start=performance.now();await readFile(concurrent);reads.push(performance.now()-start);}})();
  try{for(let i=0;i<11;i++){const start=performance.now();for(let n=0;n<calls;n++)await get(port,path,expected);samples.push(performance.now()-start);}}finally{stop=true;await reader;loop.disable();}
  results.push({mode,index,bytes:expected.length,callsPerSample:calls,...stats(samples),parentRead64KiB:stats(reads),parentEventLoop:{p95Ms:loop.percentile(95)/1e6,maxMs:loop.max/1e6}});
 }
 console.log(JSON.stringify({node:process.version,metadataRecords:metadata.status.entries,warmups:5,runs:11,results,scope:'Actual authenticated HTTP over loopback with keepalive; thumbnail storage cache versus simple Node createReadStream reference, not Python/full Moonraker equivalence. Concurrent warm 64KiB reads are scheduling probes, not physical print or MCU deadline evidence.'},null,2));
}finally{agent.destroy();await network?.close();await new Promise<void>(resolve=>{if(plain?.listening)plain.close(()=>resolve());else resolve();});await storage?.close();await rm(dir,{recursive:true,force:true});}
