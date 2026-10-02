import test from 'node:test';
import assert from 'node:assert/strict';
import {SerialButtonsInput} from '../src/inputs/serial-buttons.ts';
import type {SerialSession,ResponseSubscription,TimedCommandQueue} from '../src/protocol/serial-session.ts';
import type {ButtonBatch} from '../src/inputs/buttons.ts';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
 let handler:ResponseSubscription|undefined,detached=false;const sent:number[]=[],published:{time:number;batch:ButtonBatch}[]=[],faults:unknown[]=[];
 const session={subscribeResponse(_f:string,_o:number,h:ResponseSubscription){handler=h;return ()=>{detached=true;};},assertActive(){},configuration:{},dictionary:{encode(_name:string,p:{count:number}){return Buffer.from([p.count]);}}} as unknown as SerialSession;
 const input=new SerialButtonsInput(session,{oid:2,count:1,invert:0,initialClock:0n,commands:[],init:[]},(time,batch)=>published.push({time,batch}),e=>faults.push(e));
 const queue:TimedCommandQueue={async send(p){sent.push(p[0]);},async stop(){}};
 return {input,queue,sent,published,faults,get detached(){return detached;},emit(ack:number,state:number[],time=1){handler!.receive({message:{name:'buttons_state',parameters:{oid:2,ack_count:ack,state:Buffer.from(state)}},sentTime:0,receiveTime:time});}};
}
test('reports buffered before activation are ACKed once and published in order',async()=>{
 const f=fixture();f.emit(0,[1]);f.emit(0,[1]);f.emit(0,[1,0]);assert.deepEqual(f.sent,[]);f.input.activate(f.queue);await settle();assert.deepEqual(f.sent,[1,1]);assert.deepEqual(f.published.map(p=>p.batch.samples[0].state),[1,0]);assert.deepEqual(f.faults,[]);await f.input.close();assert(f.detached);
});
test('close waits for accepted ACK and blocks late state publication',async()=>{
 const f=fixture(),ack=Promise.withResolvers<void>();f.queue.send=()=>ack.promise;f.input.activate(f.queue);f.emit(0,[1]);let closed=false;const closing=f.input.close().then(()=>{closed=true;});await settle();assert.equal(closed,false);ack.resolve();await closing;assert.deepEqual(f.published,[]);f.emit(1,[0]);assert.deepEqual(f.published,[]);
});
test('ACK error and input overflow fault once without unbounded buffering',async()=>{
 const f=fixture();f.queue.send=async()=>{throw new Error('ack failed');};f.input.activate(f.queue);f.emit(0,[1]);await settle();assert.equal(f.faults.length,1);assert(f.input.status.closed);assert.deepEqual(f.published,[]);
 const g=fixture();for(let i=0;i<33;i++)g.emit(i,[i&1],i);assert.equal(g.faults.length,1);assert(g.input.status.closed);assert.equal(g.input.status.pending,0);await g.input.close();
});
test('native serial reports are deduplicated and acknowledged before publication',async()=>{
 const {serialFirmware}=await import('./helpers/serial-firmware.ts'),{MCUGroup}=await import('../src/runtime/mcu-group.ts'),{SerialSession}=await import('../src/protocol/serial-session.ts'),{serialClock}=await import('../src/protocol/serial-queue.ts'),{compileButtons}=await import('../src/inputs/buttons.ts');
 const fw=await serialFirmware(undefined,{buttons:true}),signal=new AbortController().signal;let input:SerialButtonsInput|undefined;const values:number[]=[],faults:unknown[]=[];
 const group=new MCUGroup([{id:'mcu',async connect(s,stopDevice){const session=new SerialSession(fw.fd,{stopDevice});await session.initialize(s);return session;},async stopDevice(){}}]);
 try{
  await group.start(signal);const session=group.session('mcu'),chip={},plan=compileButtons(chip,session.dictionary,{oid:0,pins:[{chip,chipName:'mcu',pin:'PA0',invert:0,pullup:1}],currentPrintTime:Number(session.clock.sync.getClock(serialClock.now()))/1e6},time=>BigInt(Math.trunc(time*1e6)));
  input=new SerialButtonsInput(session,plan,(_time,batch)=>{assert(fw.outputs.some(o=>o.name==='buttons_ack'));for(const s of batch.samples)values.push(s.state);},e=>faults.push(e));
  await session.configure({oidCount:1,commands:plan.commands,init:plan.init},signal);input.activate(group.commandQueue('mcu'));
  fw.emit('buttons_state',{oid:0,ack_count:0,state:Buffer.from([1,0])});fw.emit('buttons_state',{oid:0,ack_count:0,state:Buffer.from([1,0])});
  const deadline=performance.now()+2000;while(values.length<2){assert(performance.now()<deadline);await new Promise(r=>setTimeout(r,2));}
  assert.deepEqual(values,[1,0]);assert.deepEqual(fw.outputs.filter(o=>o.name==='buttons_ack').map(o=>o.parameters.count),[2]);assert.deepEqual(faults,[]);await input.close();fw.emit('buttons_state',{oid:0,ack_count:2,state:Buffer.from([1])});await new Promise(r=>setTimeout(r,10));assert.deepEqual(values,[1,0]);
 }finally{await group.stop();await input?.close();await fw.close();}
});
