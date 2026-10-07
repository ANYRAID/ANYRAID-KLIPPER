import test from 'node:test';
import assert from 'node:assert/strict';
import {ExtrusionAccounting} from '../src/gcode/extrusion-accounting.ts';
import {PrintController,type PrintDevice,type PrintControllerOptions,type PrintDeadlines} from '../src/operations/print.ts';
const request={version:1 as const,requestId:'prepared-job',fileId:'file',nozzle:200,bed:60};
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function fixture(overrides:Partial<PrintDevice>={},options:PrintControllerOptions={},deadlines:Partial<PrintDeadlines>={}){
 const calls:string[]=[],entered=Promise.withResolvers<void>(),ready=Promise.withResolvers<void>();
 const device:PrintDevice={async prepare(_job,signal){calls.push('prepare');entered.resolve();await ready.promise;signal.throwIfAborted();},async start(){calls.push('start');},async pause(){calls.push('pause');},async resume(){calls.push('resume');},async finish(){calls.push('finish');},async stop(){calls.push('stop');},...overrides};
 return {calls,entered,ready,controller:new PrintController(device,{maxNozzle:300,maxBed:120},deadlines,options)};
}
test('preparation pause coalesces, renews its token once and admits no file command until explicit resume',async()=>{
 const f=fixture();try{
  const starting=f.controller.start(request);await f.entered.promise;const before=f.controller.stateToken;
  const pause=f.controller.pause();assert.notEqual(f.controller.stateToken,before);const token=f.controller.stateToken;
  assert.equal(f.controller.pause(),pause);assert.equal(f.controller.stateToken,token);assert.equal(f.controller.pausePending,true);assert.equal(f.controller.pausedBeforeFile,false);
  f.ready.resolve();await Promise.all([starting,pause]);assert.equal(f.controller.state,'paused');assert.equal(f.controller.pausedBeforeFile,true);assert.equal(f.controller.pausePending,false);assert.deepEqual(f.calls,['prepare']);
  await f.controller.resume();assert.equal(f.controller.state,'printing');assert.equal(f.controller.pausedBeforeFile,false);assert.deepEqual(f.calls,['prepare','start']);
  await f.controller.pause();await f.controller.resume();assert.deepEqual(f.calls,['prepare','start','pause','resume']);
 }finally{f.ready.resolve();await f.controller.retire();}
});
test('registering preparation pause preserves preparation time and already accepted preparation extrusion',async()=>{
 const accounting=new ExtrusionAccounting(),f=fixture({}, {extrusionAccounting:accounting});
 try{
  const starting=f.controller.start(request);await f.entered.promise;accounting.accepted(0,2,1);
  await new Promise(resolve=>setTimeout(resolve,20));const duration=f.controller.totalDuration!;
  const pause=f.controller.pause();assert(f.controller.totalDuration!>=duration);assert.equal(accounting.filamentUsed,2);
  f.ready.resolve();await Promise.all([starting,pause]);assert.equal(accounting.filamentUsed,2);assert(f.controller.totalDuration!>=duration);
 }finally{f.ready.resolve();await f.controller.retire();}
});
for(const action of ['cancel','fault','retire'] as const)test(`preparation pause cannot outlive ${action} or start a late prepared file`,async()=>{
 const f=fixture();const starting=f.controller.start(request),startRejected=assert.rejects(starting),pause=f.controller.pause(),pauseRejected=assert.rejects(pause);
 await f.entered.promise;
 let stopped=false;const stopping=(action==='fault'?f.controller.fault(Error('lost device')):f.controller[action]()).then(()=>{stopped=true;});
 await tick();assert.equal(f.controller.pausePending,false);assert.equal(stopped,false);assert(f.calls.includes('stop'));f.ready.resolve();
 await Promise.all([startRejected,pauseRejected,stopping]);assert.equal(f.calls.includes('start'),false);assert.equal(f.controller.pendingDeviceActions,0);assert.equal(f.controller.safeStopPending,false);
 if(action!=='retire')await f.controller.retire();
});
test('a cancelled prepared hold cannot leak into the next print after terminal reset',async()=>{
 const f=fixture();try{
  const starting=f.controller.start(request),pause=f.controller.pause();f.ready.resolve();await Promise.all([starting,pause]);
  await f.controller.cancel();assert.equal(f.calls.includes('start'),false);f.controller.reset(request.requestId);assert.equal(f.controller.pausedBeforeFile,false);
  await f.controller.start({...request,requestId:'next-job'});assert.equal(f.controller.state,'printing');assert.equal(f.calls.filter(c=>c==='start').length,1);
 }finally{f.ready.resolve();await f.controller.retire();}
});
test('pause at a pending file-start ACK uses ordinary pause once and retains concurrent EOF until resume',async()=>{
 const entered=Promise.withResolvers<void>(),ack=Promise.withResolvers<void>();let eof:(id:string)=>void=()=>{};
 const f=fixture({subscribeEOF(listener){eof=listener;return ()=>{};},async start(){f.calls.push('start');entered.resolve();await ack.promise;eof(request.requestId);}});
 try{
  f.ready.resolve();const starting=f.controller.start(request);await entered.promise;const pause=f.controller.pause();assert.equal(f.controller.pausePending,true);
  ack.resolve();await Promise.all([starting,pause]);assert.equal(f.controller.state,'paused');assert.equal(f.controller.pausedBeforeFile,false);assert.deepEqual(f.calls,['prepare','start','pause']);
  await f.controller.resume();await tick();assert.equal(f.controller.state,'completed');assert.deepEqual(f.calls,['prepare','start','pause','resume','finish']);
 }finally{f.ready.resolve();ack.resolve();await f.controller.retire();}
});
test('empty-file EOF during first resume from the prepared hold reaches completion exactly once',async()=>{
 let eof:(id:string)=>void=()=>{};const f=fixture({subscribeEOF(listener){eof=listener;return ()=>{};},async start(){f.calls.push('start');eof(request.requestId);}});
 try{const starting=f.controller.start(request),pause=f.controller.pause();f.ready.resolve();await Promise.all([starting,pause]);assert.equal(f.calls.includes('start'),false);await f.controller.resume();await tick();assert.equal(f.controller.state,'completed');assert.equal(f.calls.filter(c=>c==='finish').length,1);assert.equal(f.calls.includes('resume'),false);}
 finally{f.ready.resolve();await f.controller.retire();}
});
test('resume interlocks retain the prepared hold without executing or replaying preparation',async()=>{
 let allowed=true;const f=fixture({}, {beforeStart(){if(!allowed)throw Error('unsafe start');},beforeResume(){if(!allowed)throw Error('unsafe resume');}});
 try{
  const starting=f.controller.start(request),pause=f.controller.pause();f.ready.resolve();await Promise.all([starting,pause]);allowed=false;
  await assert.rejects(f.controller.resume(),/unsafe resume/);assert.equal(f.controller.state,'paused');assert.equal(f.controller.pausedBeforeFile,true);assert.deepEqual(f.calls,['prepare']);
  allowed=true;await f.controller.resume();assert.deepEqual(f.calls,['prepare','start']);
 }finally{f.ready.resolve();await f.controller.retire();}
});
test('the original preparation deadline fences a pending pause and retains a late adapter through safety cleanup',async()=>{
 let signal:AbortSignal|undefined;const f=fixture({async prepare(_request,s){signal=s;f.calls.push('prepare');f.entered.resolve();await f.ready.promise;}},{},{startMs:10,stopMs:10});
 const starting=f.controller.start(request),startRejected=assert.rejects(starting,/operation and safe stop failed/),pause=f.controller.pause(),pauseRejected=assert.rejects(pause,/operation and safe stop failed/);
 await Promise.all([startRejected,pauseRejected]);assert(signal!.aborted);assert.equal(f.controller.state,'failed');assert.equal(f.controller.pausePending,false);assert.equal(f.controller.pendingDeviceActions,1);
 let retired=false;const retirement=f.controller.retire().then(()=>{retired=true;});await tick();assert.equal(retired,false);f.ready.resolve();await retirement;assert.equal(f.calls.includes('start'),false);assert(f.calls.filter(c=>c==='stop').length>=2);assert.equal(f.controller.pendingDeviceActions,0);
});
