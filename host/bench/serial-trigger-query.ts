import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {TriggerSyncProtocol} from '../src/inputs/trsync.ts';
import {serialFirmware} from '../test/helpers/serial-firmware.ts';
let progress:unknown;const unmatched:unknown[]=[];
const firmware=await serialFirmware(undefined,{triggerSync:true}),session=new SerialSession(firmware.fd,{async stopDevice(){},onMessage(r){if(unmatched.length<8)unmatched.push(r);}}),signal=new AbortController().signal;
try{
 await session.initialize(signal);const protocol=new TriggerSyncProtocol(session.dictionary,8);await session.configure({oidCount:9,commands:protocol.commands},signal);const queue=session.commandQueue(),command=protocol.trigger(2),times:number[][]=[[],[]];
 for(let round=0;round<14;round++)for(const mode of (round%2?[1,0]:[0,1])){
  const start=performance.now();for(let i=0;i<100;i++){
   progress={round,mode,i};
   const response=await(mode?session.queryOnQueue(queue,command,'trsync_state',signal,{oid:8}):session.query(command,'trsync_state',signal,{oid:8}));
   assert.equal(response.message.parameters.trigger_reason,2);
  }
  if(round>=3)times[mode].push(performance.now()-start);
 }
 for(const list of times)list.sort((a,b)=>a-b);
 console.log(JSON.stringify({node:process.version,queriesPerBatch:100,defaultMedianMs:times[0][5],defaultP95Ms:times[0][10],ownedQueueMedianMs:times[1][5],ownedQueueP95Ms:times[1][10],scope:'initialized Unix-stream firmware fixture, ACK and response; no physical UART or MCU scheduling'},null,2));
 assert.ok(times[1][5]<=times[0][5]*1.5,'Owned-queue query median regressed more than 50%');
}catch(error){console.error({progress,unmatched,status:session.status});throw error;}finally{await session.stop().catch(()=>{});await firmware.close();}
