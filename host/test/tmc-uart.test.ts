import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {encodeTmcRead,encodeTmcWrite,decodeTmcRead,TmcUartBus} from '../src/drivers/tmc-uart.ts';
const reference=JSON.parse(readFileSync(new URL('../contracts/tmc-uart-reference.json',import.meta.url),'utf8'));
test('UART frames match 512 original Python cases and reject every single-bit response error',()=>{
 for(const row of reference.rows){
  assert.equal(encodeTmcRead(row.address,row.register).toString('hex'),row.read);
  assert.equal(encodeTmcWrite(row.address,row.register,row.value).toString('hex'),row.write);
  const response=Buffer.from(row.response,'hex');assert.equal(decodeTmcRead(row.register,response),row.value);
  for(let bit=0;bit<80;bit++){const bad=Buffer.from(response);bad[bit>>>3]^=1<<(bit&7);assert.equal(decodeTmcRead(row.register,bad),null);}
 }
 for(const value of [-1,2**32,NaN,Infinity,1.5])assert.throws(()=>encodeTmcWrite(0,0,value));
 assert.equal(decodeTmcRead(0,Buffer.alloc(9)),null);
});
test('shared MCU bus serializes entire write verification across UARTs, including IFCNT wrap and clocks',async()=>{
 const signal=new AbortController().signal,events:string[]=[],counts=new Map([[1,255],[2,9]]);let active=0;
 const bus=new TmcUartBus({async transfer(oid,write,read,clock){
  assert.equal(active++,0);events.push(oid+':'+read);await new Promise<void>(r=>setImmediate(r));active--;
  if(!read){assert.equal(clock,9007199254740993n);counts.set(oid,(counts.get(oid)!+1)&255);return Buffer.alloc(0);}
  assert.deepEqual(write,encodeTmcRead(0,2));return encodeTmcWrite(255,2,counts.get(oid)!,true);
 }}),a=bus.register(1,0),b=bus.register(2,0);
 assert.throws(()=>bus.register(1,0),/Duplicate/);
 await Promise.all([a.write(16,0xffffffff,signal,9007199254740993n),b.write(16,123,signal,9007199254740993n)]);
 assert.deepEqual(events,['1:10','1:0','1:10','2:10','2:0','2:10']);
 await a.write(16,1,signal,9007199254740993n);assert.deepEqual(events.slice(-2),['1:0','1:10']);
});
test('corrupt replies retry at most five times; unacknowledged writes never report success',async()=>{
 const signal=new AbortController().signal;let reads=0,writes=0;
 const bad=new TmcUartBus({async transfer(){reads++;return Buffer.alloc(10);}}).register(1,0);
 await assert.rejects(bad.read(1,signal),/Unable to read/);assert.equal(reads,5);
 const device=new TmcUartBus({async transfer(_o,_w,n){if(!n){writes++;return Buffer.alloc(0);}return encodeTmcWrite(255,2,0,true);}}).register(1,0);
 await assert.rejects(device.write(16,1,signal),/Unable to write/);assert.equal(writes,5);
});
test('queued abort issues no command and transport failure fences every device',async()=>{
 const hold=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();let calls=0;
 const bus=new TmcUartBus({async transfer(){calls++;entered.resolve();await hold.promise;throw new Error('transport lost');}}),a=bus.register(1,0),b=bus.register(2,0),abort=new AbortController();
 const first=assert.rejects(a.read(1,new AbortController().signal),/transport lost/);await entered.promise;
 const second=assert.rejects(b.read(1,abort.signal),/cancelled/);abort.abort(new Error('cancelled'));hold.resolve();await Promise.all([first,second]);
 await assert.rejects(b.read(1,new AbortController().signal),/transport lost/);assert.equal(calls,1);
});
test('lost write acknowledgement retries with the newly observed count and corrupt reads recover',async()=>{
 let writes=0,reads=0,count=40;const signal=new AbortController().signal;
 const device=new TmcUartBus({async transfer(_o,_w,n){
  if(!n){writes++;if(writes>1)count++;return Buffer.alloc(0);}
  reads++;return reads===1?Buffer.alloc(0):encodeTmcWrite(255,2,count,true);
 }}).register(1,0);
 await device.write(16,0x80000000,signal);assert.equal(writes,2);assert.equal(reads,4);
});
test('abort during a physical query does not release the bus before transport completion',async()=>{
 const entered=Promise.withResolvers<void>(),settled=Promise.withResolvers<void>(),abort=new AbortController();let calls=0;
 const bus=new TmcUartBus({async transfer(){calls++;entered.resolve();await settled.promise;return encodeTmcWrite(255,1,7,true);}}),a=bus.register(1,0),b=bus.register(2,0);
 const first=assert.rejects(a.read(1,abort.signal),/stop/);await entered.promise;abort.abort(new Error('stop'));
 const second=assert.rejects(b.read(1,new AbortController().signal),/stop/);await new Promise<void>(r=>setImmediate(r));assert.equal(calls,1);
 settled.resolve();await Promise.all([first,second]);assert.equal(calls,1);
});
