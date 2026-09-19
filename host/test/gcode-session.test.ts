import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough,Writable} from 'node:stream';
import {GCodeSession} from '../src/gcode/session.ts';
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
test('real Node streams deliver ordered commands and newline acknowledgements',async()=>{
 const source=new PassThrough(),parts:string[]=[],stops:string[]=[];
 const sink=new Writable({write(chunk,encoding,done){parts.push(chunk.toString());done();}});
 const session=new GCodeSession(source,sink,r=>stops.push(r));session.dispatch.setReady(true);
 const seen:string[]=[];session.dispatch.register('G1',c=>{seen.push(c.params.X);});
 source.write('G1X1\nG1X2\n');await session.idle();assert.deepEqual(seen,['1','2']);assert.equal(parts.join(''),'ok\nok\n');assert.equal(session.pendingOutputBytes,0);
 session.close();assert.equal(stops.length,1);await tick();
});
test('slow output bounds admission but leaves emergency input readable',async()=>{
 const source=new PassThrough(),stops:string[]=[];const sink=new Writable({write(){}});
 const session=new GCodeSession(source,sink,r=>stops.push(r));session.dispatch.setReady(true);let moves=0;
 session.dispatch.register('G1',()=>{moves++;});source.write('G1X1\n'.repeat(300));await tick();
 assert.ok(moves>0&&moves<=128);assert.ok(session.pendingOutputBytes<=384);
 source.write('M112\n');await assert.rejects(session.idle());assert.equal(stops.length,1);assert.ok(stops[0].includes('M112'));assert.ok(moves<300);
});
test('write failures, output timeout and output limits stop pending motion',async()=>{
 for(const mode of ['error','timeout','limit']) {
  const source=new PassThrough(),stops:string[]=[];
  const sink=new Writable({write(chunk,encoding,done){if(mode==='error')done(new Error('private transport detail'));}});
  const session=new GCodeSession(source,sink,r=>stops.push(r),{outputTimeoutMs:10,maxOutputBytes:mode==='limit'?3:1048576});
  session.dispatch.setReady(true);session.dispatch.register('G1',()=>{});
  source.write('G1X1\nG1X2\n');await assert.rejects(session.idle());assert.equal(stops.length,1);assert.ok(!stops[0].includes('private'));
  await tick();
 }
});
test('source disconnect cancels waits and discards subsequent motion',async()=>{
 const source=new PassThrough(),sink=new PassThrough(),stops:string[]=[];
 const session=new GCodeSession(source,sink,r=>stops.push(r));session.dispatch.setReady(true);let moved=false;
 session.dispatch.register('WAIT',c=>new Promise<void>((resolve,reject)=>c.signal.addEventListener('abort',()=>reject(c.signal.reason),{once:true})));
 session.dispatch.register('G1',()=>{moved=true;});source.write('WAIT\nG1X1\n');await tick();source.end();
 await assert.rejects(session.idle());assert.equal(moved,false);assert.equal(stops.length,1);
});
test('output draining resumes without dropping or duplicating acknowledgements',async()=>{
 const source=new PassThrough(),parts:string[]=[];
 const sink=new Writable({highWaterMark:3,write(chunk,encoding,done){parts.push(chunk.toString());setImmediate(done);}});
 const session=new GCodeSession(source,sink,()=>{});session.dispatch.setReady(true);let moves=0;session.dispatch.register('G1',()=>{moves++;});
 source.write('G1X1\n'.repeat(300));await session.idle();assert.equal(moves,300);assert.equal(parts.length,300);assert.equal(session.pendingOutputBytes,0);session.close();
});

import {createServer,createConnection} from 'node:net';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('Unix domain socket exchanges responses and stops on real peer disconnect',{timeout:3000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'anyraid-gcode-socket-')),path=join(directory,'io.sock');
 let session:GCodeSession|undefined,stop!:()=>void;const stopped=new Promise<void>(resolve=>{stop=resolve;});
 const server=createServer(socket=>{session=new GCodeSession(socket,socket,()=>stop());session.dispatch.setReady(true);session.dispatch.register('G1',()=>{});});
 const client=createConnection;let peer:ReturnType<typeof createConnection>|undefined;
 try {
  server.listen(path);await once(server,'listening');peer=client(path);await once(peer,'connect');
  const replies=new Promise<string>(resolve=>{let text='';peer!.on('data',chunk=>{text+=chunk.toString();if(text==='ok\nok\n')resolve(text);});});
  peer.write('G1X1\nG1X2\n');assert.equal(await replies,'ok\nok\n');peer.destroy();await stopped;assert.equal(session?.stopped,true);
 }finally{peer?.destroy();session?.close();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(directory,{recursive:true,force:true});}
});
