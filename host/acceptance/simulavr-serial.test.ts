import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {AVREngine} from '../src/simulator/engine.ts';
const binary=fileURLToPath(new URL('../build/avrsim',import.meta.url));
test('real AVR UART echoes every byte through Node-controlled simulation batches',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'simulavr-serial-'));let engine:AVREngine|undefined;
 try{
  const elf=join(dir,'echo.elf');const built=spawnSync(process.env.AVR_CC??'avr-gcc',['-mmcu=atmega644','-Os',fileURLToPath(new URL('../test/fixtures/simulavr/echo.c',import.meta.url)),'-o',elf],{encoding:'utf8'});assert.equal(built.status,0,String(built.error??built.stderr));
  engine=new AVREngine(binary,elf);const sent=Buffer.from(Array.from({length:256},(_,i)=>i)),received:Buffer[]=[];
  let clock=0n;const samples:number[]=[];
  // Boot before transmitting, just as a host must wait for MCU readiness.
  await engine.advance(1000000);
  for(let round=0;round<10;round++){
   const started=performance.now();const result=await engine.advance(20000000,sent);
   assert.ok(result.time>clock);clock=result.time;assert.deepEqual(result.bytes,sent);received.push(result.bytes);
   if(round>=3)samples.push(performance.now()-started);
  }
  await assert.rejects(engine.advance(0),RangeError);await assert.rejects(engine.advance(1,Buffer.alloc(65537)),RangeError);
  const batch=await Promise.all([engine.advance(1000000,Buffer.from([0,255])),engine.advance(1000000,Buffer.from([85,170]))]);
  assert.deepEqual(batch.map(r=>[...r.bytes]),[[0,255],[85,170]]);
  await engine.close();await assert.rejects(engine.advance(1),/closed/);
  const malformed=(input:Buffer)=>new Promise<{status:number|null;stderr:string}>((resolve,reject)=>{
   const child=spawn(binary,['atmega644','16000000','250000',elf],{stdio:'pipe',timeout:5000});let stderr='';
   child.stderr.on('data',data=>{stderr+=data;});child.stdout.resume();child.on('error',reject);
   child.on('close',status=>resolve({status,stderr}));child.stdin.on('error',()=>{});child.stdin.end(input);
  });
  const truncated=await malformed(Buffer.from([1,2,3]));
  assert.equal(truncated.status,1);assert.match(truncated.stderr,/pipe failed/);
  const invalid=Buffer.alloc(8);invalid.writeUInt32LE(65537);invalid.writeUInt32LE(1,4);
  const oversized=await malformed(invalid);
  assert.equal(oversized.status,1);assert.match(oversized.stderr,/invalid simulation request/);
  const cancelled=new AVREngine(binary,elf),pending=assert.rejects(cancelled.advance(100000000),/aborted/);
  await cancelled.abort();await pending;
  t.diagnostic(JSON.stringify({node:process.version,bytes:Buffer.concat(received).length,warmups:3,simulatedNsPerSample:20000000,samplesMs:samples,medianMs:[...samples].sort((a,b)=>a-b)[3],scope:'Node IPC, native AVR instructions and bidirectional bit-serial UART; no PTY or wall-clock pacing'}));
 }finally{await engine?.abort();rmSync(dir,{recursive:true,force:true});}
});
test('missing native engine rejects pending operations without an unhandled exit',async()=>{
 const engine=new AVREngine('/nonexistent/avrsim','/nonexistent/firmware');
 await assert.rejects(engine.advance(1));await assert.rejects(engine.close());await engine.abort();
});
