// Synthetic Unix-stream fanout. This is not UART/MCU stop latency.
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {serialPair} from '../test/helpers/serial-pair.ts';
import {NativeSerialQueue,serialClock} from '../src/protocol/serial-queue.ts';
import {MessageDictionary} from '../src/protocol/dictionary.ts';
import {trsyncFormats,TriggerSyncProtocol} from '../src/inputs/trsync.ts';
import {FrameDecoder,encodeFrame} from '../src/protocol/codec.ts';
const dictionary=new MessageDictionary();dictionary.identify(Buffer.from(JSON.stringify({commands:{[trsyncFormats.config]:2,[trsyncFormats.start]:3,[trsyncFormats.timeout]:4,[trsyncFormats.trigger]:5,[trsyncFormats.stepper]:6},responses:{[trsyncFormats.state]:7},config:{CLOCK_FREQ:1000000}})),false);
const protocol=new TriggerSyncProtocol(dictionary,8);
async function fixture(){
 const pair=await serialPair(),queue=new NativeSerialQueue(pair.fd),decoder=new FrameDecoder();let sequence=1,received=0;
 pair.peer.on('data',chunk=>{for(const frame of decoder.push(typeof chunk==='string'?Buffer.from(chunk):chunk)){
  for(const message of dictionary.parseFrame(frame)){assert.equal(message.name,'trsync_trigger');assert.equal(message.parameters.oid,8);assert.equal(message.parameters.reason,2);received++;}
  sequence=(frame[1]+1)&15;pair.peer.write(encodeFrame(sequence,new Uint8Array()));
 }});
 return {queue,pair,get received(){return received;},report(){pair.peer.write(encodeFrame(sequence,dictionary.encode('trsync_state',{oid:8,can_trigger:0,trigger_reason:1,clock:1000001})));},async close(){queue.close();await pair.close();}};
}
const a=await fixture(),b=await fixture(),samples:number[]=[],setup:number[]=[];
try{
 for(let i=0;i<105;i++){
  for(const f of [a,b]){while(f.queue.pull()){}f.queue.setClockEstimate({frequency:1e6,sampleTime:serialClock.now(),clock:1000000n});}
  const before=performance.now(),group=NativeSerialQueue.createTriggerDispatch([a,b].map(f=>({queue:f.queue,commandQueue:3,oid:8,tags:protocol.tags,plan:protocol.start(1000000n,[1,2],.025)})));group.start();const armed=performance.now();
  try{a.report();const deadline=armed+3000;
   while(a.received<i+1||b.received<i+1){if(performance.now()>deadline)throw new Error('Trigger fanout timeout');await delay(0);}
   if(i>=5){setup.push(armed-before);samples.push(performance.now()-armed);}
  }finally{group.close();}
 }
 setup.sort((a,b)=>a-b);samples.sort((a,b)=>a-b);
 console.log(JSON.stringify({node:process.version,rounds:100,mcus:2,setupMedianMs:setup[50],setupP95Ms:setup[94],observedFanoutMedianMs:samples[50],observedFanoutP95Ms:samples[94],scope:'Unix stream injection through original C fastreader to two parsed stop commands; includes Node timers and socket observation, not hardware latency; no Python comparison'},null,2));
}finally{await a.close();await b.close();}
