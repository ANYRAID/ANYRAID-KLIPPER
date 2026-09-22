import test from 'node:test';
import assert from 'node:assert/strict';
import {PrintController,type PrintDevice} from '../src/operations/print.ts';
const device=():PrintDevice=>({async prepare(){},async start(){},async pause(){},async resume(){},async finish(){},async stop(){}});
const request={version:1 as const,requestId:'job',fileId:'file',nozzle:200,bed:60};
test('slow state readers retain only current unread state and cannot mutate controller state',async()=>{
 const controller=new PrintController(device(),{maxNozzle:300,maxBed:120}),abort=new AbortController(),stream=controller.watchState(abort.signal);
 const initial=await stream.next();assert.equal(initial.value.state,'idle');assert.ok(Object.isFrozen(initial.value));
 await controller.start(request);for(let i=0;i<1000;i++){await controller.pause();await controller.resume();}
 const latest=await stream.next();assert.deepEqual(latest.value,{state:'printing',stateToken:controller.stateToken});
 assert.throws(()=>{latest.value.state='idle';},TypeError);assert.equal(controller.state,'printing');
 const pending=stream.next();await assert.rejects(stream.next(),/already pending/);abort.abort();assert.equal((await pending).done,true);assert.equal((await stream.next()).done,true);assert.equal(controller.stateObservers,0);await controller.cancel();
});
test('state observers are bounded, detachable and never called in the transition stack',async()=>{
 const controller=new PrintController(device(),{maxNozzle:300,maxBed:120}),signal=new AbortController().signal;
 assert.throws(()=>controller.watchState(AbortSignal.abort()),/abort/i);
 const streams=Array.from({length:64},()=>controller.watchState(signal));assert.throws(()=>controller.watchState(signal),/capacity/);
 for(const stream of streams)await stream.return?.();assert.equal(controller.stateObservers,0);
 const stream=controller.watchState(signal);await stream.next();let called=false;
 const read=stream.next().then(value=>{called=true;assert.equal(value.value.state,'preparing');});
 const started=controller.start(request);assert.equal(called,false);await read;await started;
 await stream.return?.();assert.equal(controller.stateObservers,0);await controller.cancel();
});
