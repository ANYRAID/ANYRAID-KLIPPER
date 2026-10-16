import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {HttpResponse,MoonrakerHttpClient} from '../src/moonraker/http-client.ts';
import {parseRequestJson} from '../src/moonraker/json.ts';
import {validateJson} from '../src/moonraker/rpc.ts';
import type {ExactJson} from '../src/moonraker/json-exact.ts';
const reference=JSON.parse(await readFile(new URL('../contracts/http-json-bytes-reference.json',import.meta.url),'utf8')) as {rows:{name:string;hex:string;accepted:boolean;expected?:unknown}[]};
function normalized(value:ExactJson):unknown{
 if(typeof value==='bigint')return {$exactInteger:value.toString()};
 if(typeof value==='number'&&Object.is(value,-0))return {$negativeZero:true};
 if(Array.isArray(value))return value.map(normalized);
 if(value!==null&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,normalized(item)]));return value;
}
function response(bytes:Uint8Array){return new HttpResponse('/fixture','/fixture',200,bytes,new Headers({'content-type':'application/json; charset=latin-1'}),null);}
for(const row of reference.rows)test('HTTP JSON bytes match frozen pinned stdlib fallback: '+row.name,()=>{
 const source=Buffer.from(row.hex,'hex'),copy=Buffer.from(source),value=response(source);
 value.encoding='ascii'; // JSON autodetection is independent of text/header codecs.
 if(row.accepted)assert.deepEqual(normalized(value.json()),row.expected);else assert.throws(()=>value.json());
 assert.deepEqual(source,copy);assert.deepEqual(value.content,copy);
});
test('all Unicode JSON encodings retain exact integer limits, negative zero and public RPC guards',()=>{
 for(const row of reference.rows.filter(row=>row.name.endsWith(' mixed'))){
  const value=response(Buffer.from(row.hex,'hex')),parsed=value.json() as {exact:bigint;negative:number};
  assert.equal(parsed.exact,2n**255n+57n);assert(Object.is(parsed.negative,-0));assert.throws(()=>value.json({integerDigits:10}),/capacity/);assert.throws(()=>validateJson(parsed),/Non-JSON/);
 }
 assert.throws(()=>parseRequestJson('{"exact":9007199254740993}'),/safe range/);
 for(const codec of ['utf8','utf16le'] as const)assert.throws(()=>response(Buffer.from('{"value":1e400}',codec)).json(),/finite/);
 const text=response(Buffer.from('22eda08022','hex'));assert.throws(()=>text.text,'text decoding remains strict even when JSON supports surrogatepass');
});
test('UTF-32 decoding spans multiple bounded chunks without changing code points or rounding numbers',()=>{
 const literal='打印机🖨'.repeat(2048),wire=JSON.stringify({literal,exact:'placeholder'}).replace('"placeholder"',(2n**255n+57n).toString()),points=Array.from(wire,character=>character.codePointAt(0)!);
 for(const little of [false,true]){
  const body=Buffer.alloc(points.length*4);for(let i=0;i<points.length;i++)if(little)body.writeUInt32LE(points[i],i*4);else body.writeUInt32BE(points[i],i*4);
  assert.deepEqual(response(body).json(),{literal,exact:2n**255n+57n});
 }
});
test('real HTTP compression and 304 cache reuse retain original Unicode bytes and decoded capacity',async()=>{
 const {gzipSync}=await import('node:zlib'),bytes=Buffer.from('\ufeff{"name":"打印机 🖨","exact":9007199254740993}', 'utf16le');let requests=0;
 const server=createServer((req,res)=>{
  requests++;if(req.headers['if-none-match']==='"utf16"'){res.writeHead(304,{etag:'"utf16"'});res.end();}
  else{const compressed=gzipSync(bytes);res.writeHead(200,{etag:'"utf16"','content-encoding':'gzip','content-type':'application/json; charset=ascii','content-length':compressed.length});res.end(compressed);}
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert(address&&typeof address==='object');const url='http://127.0.0.1:'+address.port,client=new MoonrakerHttpClient();
 try{
  const first=await client.get(url);assert.deepEqual(first.content,bytes);assert.deepEqual(first.json(),{name:'打印机 🖨',exact:9007199254740993n});first.content.fill(0);
  const cached=await client.get(url);assert.equal(cached.statusCode,304);assert.deepEqual(cached.content,bytes);assert.deepEqual(cached.json(),first.json());
  const bounded=await client.get(url,{maxBodyBytes:bytes.length-1});assert(bounded.hasError());assert.equal(client.status.cacheEntries,0);assert.equal(requests,3);
 }finally{await client.close();await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});}
});
