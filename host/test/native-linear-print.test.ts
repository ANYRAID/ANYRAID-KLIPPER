import test from 'node:test';
import assert from 'node:assert/strict';
import {nativePrintFixture} from './helpers/native-linear-print.ts';
import {createNativeLinearPrint} from '../src/operations/native-linear-print.ts';
const signal=()=>new AbortController().signal,request={version:1 as const,requestId:'job',fileId:'file',nozzle:200,bed:60};
test('assembled thermal file print waits for native drain and both heater off acknowledgements',async()=>{
 const f=await nativePrintFixture(undefined,true),owner=await createNativeLinearPrint(f.options);
 try{
  const eof=Promise.withResolvers<void>();owner.device.subscribeEOF(()=>eof.resolve());await owner.device.prepare(request,signal());await owner.device.start('file',signal());await eof.promise;
  let finished=false;const completion=owner.device.finish('job',signal()).then(()=>{finished=true;});
  const deadline=performance.now()+3000;while(f.resetCounts.some(n=>n<2)){assert(performance.now()<deadline);await new Promise(resolve=>setTimeout(resolve,2));}
  assert.equal(finished,false);assert.equal(f.outputFinishes,1);assert(f.reports.some(s=>s.includes('T:220.0 /200.0')&&s.includes('B:80.0 /60.0')));
  assert.deepEqual(new Map(f.t.generation.motion.bindings.map(b=>[b.id,b.history.status.lastPlannedPosition])),new Map([['x',200n],['e',21n],['y',0n],['z',0n]]));
  f.off.resolve();await completion;assert.equal(f.heaters.getTemperature('extruder').target,0);assert.equal(f.heaters.getTemperature('bed').target,0);assert.equal(f.outputStops,0);
 }finally{f.off.resolve();await owner.close();await f.close();}
});
test('heater fault cancels an active file command and invalidates native motion without another command',async()=>{
 const f=await nativePrintFixture('WAIT\nG1 X51\n'),entered=Promise.withResolvers<void>();f.gcode.dispatch.register('WAIT',c=>new Promise<void>((resolve,reject)=>{c.signal.addEventListener('abort',()=>reject(c.signal.reason),{once:true});entered.resolve();}));const owner=await createNativeLinearPrint(f.options);
 try{
  await owner.device.prepare(request,signal());await owner.device.start('file',signal());await entered.promise;
  await f.runtimes[0].shutdown(new Error('sensor disconnected'));assert.equal(f.t.port.status.failed,true);assert(owner.device.status.fault);await owner.device.stop();assert.equal(owner.file.status.file?.closed,true);assert.equal(f.outputStops,1);assert.equal(f.outputFinishes,0);assert.equal(f.t.f.fw.motion.length,0);
 }finally{await owner.close();await f.close();}
});
test('failed command binding closes all transferred motion, heater and output owners',async()=>{
 const f=await nativePrintFixture();f.gcode.dispatch.register('M105',()=>{});
 try{await assert.rejects(createNativeLinearPrint(f.options),/Duplicate command/);assert.equal(f.t.port.status.failed,true);assert.equal(f.heaters.status.closed,true);assert.equal(f.outputStops,1);assert.equal(f.t.f.stops,1);}
 finally{await f.close();}
});
test('cancellation of preparation cannot re-enable dispatch or start late heating',async()=>{
 const f=await nativePrintFixture(),gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();f.options.lifecycle.prepare=async()=>{entered.resolve();await gate.promise;};const owner=await createNativeLinearPrint(f.options);
 try{
  const pending=owner.device.prepare(request,signal()),failed=assert.rejects(pending);await entered.promise;await owner.device.stop();gate.resolve();await failed;
  assert.equal(f.heaters.getTemperature('extruder').target,0);assert.equal(f.heaters.getTemperature('bed').target,0);await assert.rejects(f.gcode.dispatch.execute('G1 X51'));assert.equal(f.t.f.fw.motion.length,0);assert.equal(f.outputStops,1);
 }finally{gate.resolve();await owner.close();await f.close();}
});
