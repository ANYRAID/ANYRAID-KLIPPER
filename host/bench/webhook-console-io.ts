import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {Readable,Writable} from 'node:stream';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {webhookConsole,ConsoleFrames} from '../src/diagnostics/webhook-console.ts';
const runs=[{name:'current',run:webhookConsole}];if(process.env.BASELINE_MODULE)runs.unshift({name:'before',run:(await import(pathToFileURL(process.env.BASELINE_MODULE).href)).webhookConsole});
const dir=await mkdtemp(join(tmpdir(),'console-io-bench-')),path=join(dir,'socket'),input=Array.from({length:1000},(_,i)=>`{"id":${i},"method":"info"}\n`).join(''),server=createServer(socket=>{const frames=new ConsoleFrames(3);socket.on('error',()=>{});socket.on('data',chunk=>{for(const frame of frames.push(Buffer.from(chunk)))socket.write(Buffer.concat([frame,Buffer.of(3)]));});});
try{await new Promise<void>(r=>server.listen(path,r));for(const implementation of runs){const times:number[]=[];let peak=0;for(let i=0;i<16;i++){let sends=0,replies=0;const output=new Writable({write(chunk,_encoding,done){peak=Math.max(peak,output.listenerCount('error'));const text=chunk.toString();if(text.startsWith('SEND:'))sends++;if(text.startsWith('GOT:'))replies++;done();}}),errors=new Writable({write(_chunk,_encoding,done){done();}}),at=performance.now();await implementation.run(path,Readable.from([input]),output,errors,new AbortController().signal);if(i>=5)times.push(performance.now()-at);assert.equal(sends,1000);assert.equal(replies,1000);await new Promise(r=>setImmediate(r));}times.sort((a,b)=>a-b);console.log(JSON.stringify({implementation:implementation.name,node:process.version,requests:1000,warmups:5,runs:11,medianMs:times[5],p95Ms:times[10],peakErrorListeners:peak,scope:'Full local Unix socket console exchange with synchronous in-memory output; includes connection, framing, SEND/GOT writes and close. Excludes process startup and real terminal/MCU timing.'}));}}finally{await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
