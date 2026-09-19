import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrintController } from '../src/operations/print.ts';
import type { PrintDevice,StartPrint } from '../src/operations/print.ts';
const request:StartPrint={version:1,requestId:'job1',fileId:'file1',nozzle:210,bed:60};
function fixture(overrides:Partial<PrintDevice>={}) {
  const calls:string[]=[];
  const device:PrintDevice={prepare:async()=>{calls.push('prepare');},start:async()=>{calls.push('start');},pause:async()=>{calls.push('pause');},resume:async()=>{calls.push('resume');},stop:async()=>{calls.push('stop');},...overrides};
  return {calls,controller:new PrintController(device,{maxNozzle:280,maxBed:110})};
}
test('versioned requests validate temperatures and opaque file IDs before side effects',async() => {
  const {calls,controller}=fixture();
  for(const invalid of [{...request,nozzle:NaN},{...request,nozzle:281},{...request,fileId:'../file.gcode'},{...request,bed:-1}])
    await assert.rejects(controller.start(invalid),/Invalid/);
  assert.deepEqual(calls,[]); assert.equal(controller.state,'idle');
});
test('start is idempotent; pause and resume are state constrained',async() => {
  const {calls,controller}=fixture();
  const first=controller.start(request);
  assert.equal(first,controller.start({...request}));
  await assert.rejects(controller.start({...request,bed:65}),/conflicts/);
  await first; assert.equal(controller.state,'printing');
  await controller.pause(); await controller.pause();
  assert.equal(controller.state,'paused');
  await controller.resume(); await controller.cancel();
  assert.deepEqual(calls,['prepare','start','pause','resume','stop']);
  assert.equal(controller.state,'cancelled');
  await assert.rejects(controller.resume(),/Cannot resume/);
});
test('cancellation during heating cannot start printing or release before safe stop',async() => {
  let prepared:()=>void=()=>{};
  const entered=new Promise<void>(resolve=>{prepared=resolve;});
  let release:()=>void=()=>{};
  const stopped=new Promise<void>(resolve=>{release=resolve;});
  const {controller,calls}=fixture({prepare:async(_r,signal)=>{
    prepared(); await new Promise<void>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  },stop:async()=>{await stopped;}});
  const pending=controller.start(request);
  const rejected=assert.rejects(pending,/cancelled/);
  await entered;
  const cancellation=controller.cancel();
  assert.equal(cancellation,controller.cancel());
  await rejected; assert.equal(controller.state,'cancelling');
  release(); await cancellation;
  assert.equal(controller.state,'cancelled'); assert.deepEqual(calls,[]);
});
test('adapter failures attempt safe stop and remain failed',async() => {
  const {controller,calls}=fixture({start:async()=>{throw new Error('Disconnected');}});
  await assert.rejects(controller.start(request),/Disconnected/);
  assert.equal(controller.state,'failed'); assert.deepEqual(calls,['prepare','stop']);
  await assert.rejects(controller.start({...request,requestId:'job2'}),/Cannot start/);
});
