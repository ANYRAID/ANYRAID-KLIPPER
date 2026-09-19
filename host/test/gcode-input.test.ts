import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
import {GCodeInput} from '../src/gcode/input.ts';
function setup(){const output:string[]=[],stops:string[]=[];const dispatch=new GCodeDispatch({output:m=>output.push(m),shutdown:r=>stops.push(r)});dispatch.setReady(true);return {dispatch,input:new GCodeInput(dispatch),output,stops};}
test('every byte boundary preserves UTF-8, CRLF and command order',async()=>{
 const bytes=Buffer.from('M117 打印准备\r\nG1X1\nG1X2\n');
 for(let split=0;split<=bytes.length;split++) {
  const {dispatch,input,output}=setup();const seen:string[]=[];
  dispatch.register('M117',c=>{seen.push(c.rawParameters());});dispatch.register('G1',c=>{seen.push(c.params.X);});
  input.receive(bytes.subarray(0,split));input.receive(bytes.subarray(split));await input.end();
  assert.deepEqual(seen,['打印准备','1','2']);assert.deepEqual(output,['ok','ok','ok']);assert.equal(input.pendingLines,0);assert.equal(input.bufferedCharacters,0);
 }
});
test('M112 in a later chunk interrupts a waiting handler and discards pending motion',async()=>{
 const {dispatch,input,stops}=setup();let moved=false;
 dispatch.register('WAIT',c=>new Promise<void>((resolve,reject)=>{c.signal.addEventListener('abort',()=>reject(c.signal.reason),{once:true});}));dispatch.register('G1',()=>{moved=true;});
 input.receive(Buffer.from('WAIT\nG1X1\n'));await new Promise(resolve=>setImmediate(resolve));
 input.receive(Buffer.from('N12 M11'));assert.throws(()=>input.receive(Buffer.from('2*42;stop\n')),/M112/);
 await assert.rejects(input.idle(),/M112/);assert.equal(moved,false);assert.equal(stops.length,1);
});
test('emergency pre-scan prevents same-chunk moves and ignores comments/message text',async()=>{
 const {dispatch,input,stops}=setup();let moved=0;dispatch.register('G1',()=>{moved++;});dispatch.register('M117',()=>{});
 input.receive(Buffer.from(';M112\nM117 M112\n'));await input.idle();assert.equal(stops.length,0);
 assert.throws(()=>input.receive(Buffer.from('G1X1\nM112\nG1X2\n')),/M112/);await assert.rejects(input.idle());assert.equal(moved,0);
});
test('invalid encoding, oversized lines/chunks and incomplete EOF fail closed',async()=>{
 for(const bytes of [Buffer.from([0xff]),Buffer.alloc(65537,65),Buffer.from('G1\0\n')]){
  const {input,stops}=setup();assert.throws(()=>input.receive(bytes));await assert.rejects(input.idle());assert.equal(stops.length,1);
 }
 for(const bytes of [Buffer.from('G1X1'),Buffer.from([0xe4,0xb8])]){
  const {input}=setup();input.receive(bytes);await assert.rejects(input.end());
 }
 const {input}=setup();input.receive(Buffer.alloc(65536,65));assert.throws(()=>input.receive(Buffer.from('A')),/line limit/);
});
test('live backlog is bounded even while an async command has not completed',async()=>{
 const {dispatch,input}=setup();dispatch.register('WAIT',c=>new Promise<void>((resolve,reject)=>{c.signal.addEventListener('abort',()=>reject(c.signal.reason),{once:true});}));
 input.receive(Buffer.from('WAIT\n'));await new Promise(resolve=>setImmediate(resolve));
 const block=Buffer.from('M110\n'.repeat(1000));for(let i=0;i<16;i++)input.receive(block);
 assert.throws(()=>input.receive(block),/buffer limit/);await assert.rejects(input.idle());
});
