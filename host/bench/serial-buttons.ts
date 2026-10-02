import assert from 'node:assert/strict';
import {SerialButtonsInput} from '../src/inputs/serial-buttons.ts';
import type {SerialSession,ResponseSubscription} from '../src/protocol/serial-session.ts';
const samples:number[]=[];const polls=20000;
for(let run=0;run<14;run++){
 let handler:ResponseSubscription|undefined,acks=0,published=0;
 const session={subscribeResponse(_f:string,_o:number,h:ResponseSubscription){handler=h;return ()=>{};},assertActive(){},configuration:{},dictionary:{encode(_name:string,p:{count:number}){return Buffer.from([p.count]);}}} as unknown as SerialSession;
 const input=new SerialButtonsInput(session,{oid:0,count:1,invert:0,initialClock:0n,commands:[],init:[]},(_t,b)=>{published+=b.samples.length;},e=>{throw e;});
 input.activate({async send(payload){acks+=payload[0];},async stop(){}});const start=performance.now();
 for(let i=0;i<polls;i++){handler!.receive({message:{name:'buttons_state',parameters:{oid:0,ack_count:i&255,state:Buffer.from([i&1])}},sentTime:0,receiveTime:i});if(i%16===15)while(input.status.pending)await new Promise<void>(r=>queueMicrotask(r));}
 while(input.status.pending)await new Promise<void>(r=>queueMicrotask(r));const elapsed=performance.now()-start;assert.equal(acks,polls);assert.equal(published,polls);await input.close();if(run>=3)samples.push(elapsed);
}
samples.sort((a,b)=>a-b);assert(samples[10]<1000,'Button delivery must process more than the 500Hz MCU polling rate');
console.log(JSON.stringify({node:process.version,reports:polls,samples:11,medianMs:samples[5],p95Ms:samples[10],scope:'Serialized ACK and consumer publication with immediate synthetic transport, not physical UART throughput'}));
