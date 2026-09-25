import test from 'node:test';
import assert from 'node:assert/strict';
import {nativePrintFixture} from './helpers/native-linear-print.ts';
import {createNativeLinearPrint} from '../src/operations/native-linear-print.ts';
const signal=()=>new AbortController().signal,request={version:1 as const,requestId:'job',fileId:'file',nozzle:200,bed:60};
test('assembled thermal file print waits for native drain and both heater off acknowledgements',async()=>{
 const f=await nativePrintFixture(undefined,true),owner=await createNativeLinearPrint(f.options);
 try{
  f.gcode.layers.reset('old');f.gcode.layers.update({TOTAL_LAYER:'20',CURRENT_LAYER:'10'});const eof=Promise.withResolvers<void>();owner.device.subscribeEOF(()=>eof.resolve());await owner.device.prepare(request,signal());assert.equal(f.gcode.layers.requestId,'job');assert.deepEqual(f.gcode.layers.status,{total_layer:null,current_layer:null});await owner.device.start('file',signal());await eof.promise;
  let finished=false;const completion=owner.device.finish('job',signal()).then(()=>{finished=true;});
  const deadline=performance.now()+3000;while(f.resetCounts.some(n=>n<2)){assert(performance.now()<deadline);await new Promise(resolve=>setTimeout(resolve,2));}
  assert.equal(finished,false);assert.equal(f.outputFinishes,1);assert(f.reports.some(s=>s.includes('T:220.0 /200.0')&&s.includes('B:80.0 /60.0')));
  assert.deepEqual(new Map(f.t.generation.motion.bindings.map(b=>[b.id,b.history.status.lastPlannedPosition])),new Map([['x',200n],['e',21n],['y',0n],['z',0n]]));
  const reports=f.reports.length;let queried=false;const query=f.gcode.dispatch.execute('M105').then(()=>{queried=true;});await new Promise<void>(r=>setImmediate(r));assert.equal(queried,false);assert.equal(f.reports.length,reports);
  f.off.resolve();await completion;await query;assert.equal(f.heaters.getTemperature('extruder').target,0);assert.equal(f.heaters.getTemperature('bed').target,0);assert.equal(f.outputStops,0);assert(f.reports.at(-1)!.includes('/0.0'));
 }finally{f.off.resolve();await owner.close();await f.close();}
});
test('new task layer reset waits for prior dispatch ownership and discards queued old metadata',async()=>{
 const f=await nativePrintFixture(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();f.gcode.dispatch.register('WAIT_LAYER',async()=>{entered.resolve();await release.promise;});const owner=await createNativeLinearPrint(f.options);let pending:Promise<void>|undefined,older:Promise<void>|undefined;
 try{
  f.gcode.layers.reset('old');f.gcode.layers.update({TOTAL_LAYER:'20',CURRENT_LAYER:'10'});f.gcode.enable();older=f.gcode.dispatch.execute('WAIT_LAYER\nSET_PRINT_STATS_INFO CURRENT_LAYER=9');void older.catch(()=>{});await entered.promise;
  pending=owner.device.prepare(request,signal());void pending.catch(()=>{});const end=performance.now()+3000;while(!owner.file.status.file){assert(performance.now()<end);await new Promise<void>(resolve=>setImmediate(resolve));}
  assert.equal(f.gcode.layers.requestId,'old');assert.equal(f.gcode.layers.status.current_layer,10);release.resolve();await older;await pending;assert.equal(f.gcode.layers.requestId,'job');assert.deepEqual(f.gcode.layers.status,{total_layer:null,current_layer:null});assert.equal(f.t.f.fw.motion.length,0);
 }finally{release.resolve();await owner.close();await Promise.allSettled([pending,older]);await f.close();}
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
for(const policy of ['hold','release'] as const)test(`file completion applies explicit motor policy: ${policy}`,async()=>{
 const f=await nativePrintFixture(undefined,false,true);f.options.motorCompletion=policy;const owner=await createNativeLinearPrint(f.options);
 try{
  // The assembled policy cannot be changed by later mutation of caller options.
  f.options.motorCompletion=policy==='hold'?'release':'hold';
  const eof=Promise.withResolvers<void>();owner.device.subscribeEOF(()=>eof.resolve());owner.device.subscribeFault(e=>eof.reject(e));
  await owner.device.prepare(request,signal());await owner.device.start('file',signal());await eof.promise;await owner.device.finish('job',signal());
  const writes=f.t.f.fw.outputs.filter(m=>m.name==='queue_digital_out');assert.deepEqual(writes.map(m=>m.parameters.on_ticks),policy==='release'?[0,1]:[0]);
  assert.equal(f.t.generation.motorEnable!.status.lines[0].enabled,policy==='hold');assert.equal(f.t.kinematics.status.homedAxes,policy==='release'?'':'xyz');
  if(policy==='release')assert(f.t.generation.members[0].session.clock.sync.lastClock>BigInt(Number(writes[1].parameters.clock))+100000n);
  assert.equal(f.outputFinishes,1);assert.equal(f.outputStops,0);assert.equal(f.t.port.status.failed,false);assert.deepEqual(f.resetCounts,[2,2]);assert.equal(owner.device.status.requestId,undefined);
 }finally{await owner.close();await f.close();}
});
test('motor release policy is validated before native ownership transfer',async()=>{
 const f=await nativePrintFixture();
 try{
  f.options.motorCompletion='release';await assert.rejects(createNativeLinearPrint(f.options),/motor completion policy/);
  assert.equal(f.t.port.status.failed,false);assert.equal(f.heaters.status.closed,false);assert.equal(f.outputStops,0);
  f.options.motorCompletion=undefined as never;await assert.rejects(createNativeLinearPrint(f.options),/motor completion policy/);
  f.options.motorCompletion='hold';const owner=await createNativeLinearPrint(f.options);await owner.close();
 }finally{await f.close();}
});
for(const cancel of [false,true])test(`file completion waits for motor off ACK and cannot succeed after stop (${cancel})`,async()=>{
 const {DigitalOutput}=await import('../src/outputs/digital.ts'),original=DigitalOutput.prototype.setDigital,gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();
 DigitalOutput.prototype.setDigital=async function(time,value,s){await original.call(this,time,value,s);if(!value){entered.resolve();await gate.promise;}};
 const f=await nativePrintFixture(undefined,false,true);f.options.motorCompletion='release';const owner=await createNativeLinearPrint(f.options);
 try{
  const eof=Promise.withResolvers<void>();owner.device.subscribeEOF(()=>eof.resolve());owner.device.subscribeFault(e=>eof.reject(e));
  await owner.device.prepare(request,signal());await owner.device.start('file',signal());await eof.promise;
  let finished=false;const completion=owner.device.finish('job',signal()).then(()=>{finished=true;});const result=cancel?assert.rejects(completion):completion;
  await entered.promise;assert.equal(finished,false);assert.equal(owner.device.status.requestId,'job');assert.equal(f.outputFinishes,1);assert.deepEqual(f.resetCounts,[1,1]);
  if(cancel)await owner.device.stop();gate.resolve();await result;
  assert.equal(finished,!cancel);assert.equal(f.t.port.status.failed,cancel);assert.equal(f.outputStops,cancel?1:0);assert.equal(f.heaters.getTemperature('extruder').target,0);
 }finally{gate.resolve();DigitalOutput.prototype.setDigital=original;await owner.close();await f.close();}
});
test('typed startup homes through native trigger recovery before heating and file movement',async()=>{
 const {nativePrintHomingFixture}=await import('./helpers/native-print-homing.ts'),h=await nativePrintHomingFixture(),f=h.f,owner=await createNativeLinearPrint(f.options);
 try{
  f.options.startupHoming.axes=[]; // Already-assembled policy owns its snapshot.
  assert.equal(f.t.kinematics.status.homedAxes,'');await owner.device.prepare(request,signal());assert.equal(h.hits,1);assert.equal(f.t.kinematics.status.homedAxes,'x');assert.equal(f.t.port.position()[0],51);
  const eof=Promise.withResolvers<void>();owner.device.subscribeEOF(()=>eof.resolve());owner.device.subscribeFault(e=>eof.reject(e));await owner.device.start('file',signal());await eof.promise;await owner.device.finish('job',signal());
  assert.equal(f.t.port.position()[0],51.5);assert.equal(f.t.port.status.failed,false);assert.equal(f.t.f.stops,0);
 }finally{await owner.close();await h.close();}
});
test('required homing authority is checked before starting heaters',async()=>{
 const f=await nativePrintFixture();f.options.lifecycle.prepare=async()=>{};const owner=await createNativeLinearPrint(f.options);
 try{await assert.rejects(owner.device.prepare(request,signal()),/requires homed axes/);assert.equal(f.heaters.getTemperature('extruder').target,0);assert.equal(f.heaters.getTemperature('bed').target,0);assert.equal(f.t.f.fw.motion.length,0);assert.equal(f.t.port.status.failed,true);}
 finally{await owner.close();await f.close();}
});
test('invalid startup homing configuration rejects before taking device ownership',async()=>{
 const f=await nativePrintFixture();try{
  for(const policy of [undefined,{mode:'home',axes:[]},{mode:'home',axes:[0,0]},{mode:'home',axes:[3]}]){f.options.startupHoming=policy as never;await assert.rejects(createNativeLinearPrint(f.options),/homing policy/);assert.equal(f.t.port.status.failed,false);assert.equal(f.heaters.status.closed,false);}
 }finally{await f.close();}
});
test('cancelling native startup homing stops the group before any heating begins',async()=>{
 const {nativePrintHomingFixture}=await import('./helpers/native-print-homing.ts'),h=await nativePrintHomingFixture(),f=h.f;h.stopTriggers();const owner=await createNativeLinearPrint(f.options);
 try{
  const prepare=owner.device.prepare(request,signal()),failed=assert.rejects(prepare),deadline=performance.now()+3000;
  while(!f.t.f.fw.outputs.some(m=>m.name==='endstop_home'&&Number(m.parameters.sample_count)>0)){assert(performance.now()<deadline,'startup homing did not arm');await new Promise(r=>setTimeout(r,2));}
  await owner.device.stop();await failed;assert.equal(f.t.kinematics.status.homedAxes,'');assert.equal(f.t.port.status.failed,true);assert.equal(f.t.f.stops,1);assert.equal(f.heaters.getTemperature('extruder').target,0);assert.equal(f.heaters.getTemperature('bed').target,0);assert.equal(f.outputFinishes,0);
 }finally{await owner.close();await h.close();}
});
for(const stop of [false,true])test(`completion retains dispatch during output acknowledgement (stop=${stop})`,async()=>{
 const f=await nativePrintFixture(undefined,false,true),entered=Promise.withResolvers<void>(),gate=Promise.withResolvers<void>(),finish=f.options.lifecycle.finishOutputs;f.options.motorCompletion='release';f.options.lifecycle.finishOutputs=async(id,s)=>{await finish(id,s);entered.resolve();await gate.promise;};const owner=await createNativeLinearPrint(f.options);
 try{
  const eof=Promise.withResolvers<void>();owner.device.subscribeEOF(()=>eof.resolve());await owner.device.prepare(request,signal());await owner.device.start('file',signal());await eof.promise;
  const completion=owner.device.finish('job',signal()),result=stop?assert.rejects(completion):completion;await entered.promise;
  const before=f.reports.length;let queried=false;const query=f.gcode.dispatch.execute('M105').then(()=>{queried=true;}),queryResult=stop?assert.rejects(query,/invalidated|stopped|closed/i):query;
  await new Promise<void>(r=>setImmediate(r));assert.equal(queried,false);assert.equal(f.reports.length,before);assert.deepEqual(f.t.f.fw.outputs.filter(m=>m.name==='queue_digital_out').map(m=>m.parameters.on_ticks),[0]);
  if(stop)await owner.device.stop();gate.resolve();await result;await queryResult;assert.equal(queried,!stop);assert.equal(f.t.port.status.failed,stop);assert.equal(f.heaters.getTemperature('extruder').target,0);
 }finally{gate.resolve();await owner.close();await f.close();}
});
test('completion waits for a prior command to retire before draining or finishing outputs',async()=>{
 const f=await nativePrintFixture(),entered=Promise.withResolvers<void>(),gate=Promise.withResolvers<void>();f.gcode.dispatch.register('WAIT',async()=>{entered.resolve();await gate.promise;});const owner=await createNativeLinearPrint(f.options);
 try{
  const eof=Promise.withResolvers<void>();owner.device.subscribeEOF(()=>eof.resolve());await owner.device.prepare(request,signal());await owner.device.start('file',signal());await eof.promise;
  const command=f.gcode.dispatch.execute('WAIT');await entered.promise;const completion=owner.device.finish('job',signal());await new Promise<void>(r=>setImmediate(r));assert.equal(f.outputFinishes,0);assert.deepEqual(f.resetCounts,[1,1]);gate.resolve();await command;await completion;assert.equal(f.outputFinishes,1);assert.deepEqual(f.resetCounts,[2,2]);assert.equal(f.t.port.status.failed,false);
 }finally{gate.resolve();await owner.close();await f.close();}
});
test('failed final output acknowledgement stops native motion and heaters and invalidates queued work',async()=>{
 const f=await nativePrintFixture(),gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();f.options.lifecycle.finishOutputs=async()=>{entered.resolve();await gate.promise;throw new Error('final output failed');};const owner=await createNativeLinearPrint(f.options);
 try{
  const eof=Promise.withResolvers<void>();owner.device.subscribeEOF(()=>eof.resolve());await owner.device.prepare(request,signal());await owner.device.start('file',signal());await eof.promise;
  const completion=owner.device.finish('job',signal()),failed=assert.rejects(completion,/final output failed/);await entered.promise;const queued=f.gcode.dispatch.execute('M105'),invalidated=assert.rejects(queued,/invalidated/);gate.resolve();await failed;await invalidated;await owner.device.stop();assert.equal(f.t.port.status.failed,true);assert.equal(f.t.f.stops,1);assert.equal(f.heaters.getTemperature('extruder').target,0);assert.equal(f.outputStops,1);
 }finally{gate.resolve();await owner.close();await f.close();}
});
