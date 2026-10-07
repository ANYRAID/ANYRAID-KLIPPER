import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {productMachineFixture} from './helpers/product-machine.ts';
import {loadProductMachineProfile} from '../src/runtime/product-machine-profile.ts';
import {startConfiguredProductService} from '../src/runtime/product-service.ts';
import {gridStopTrace} from './helpers/grid-stop-trace.ts';
test('grid stop evidence retains a thermal source even when the motion port reports its later cleanup',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'grid-stop-control-')),f=await productMachineFixture(dir),signal=new AbortController().signal;
 let profile:Awaited<ReturnType<typeof loadProductMachineProfile>>|undefined,service:Awaited<ReturnType<typeof startConfiguredProductService>>|undefined,trace:ReturnType<typeof gridStopTrace>|undefined;
 let primary:unknown;
 try{
  profile=await loadProductMachineProfile(f.path,async()=>f.bindings,signal);service=await startConfiguredProductService(profile.reader,profile.policies,profile.product,profile.options,signal);
  trace=gridStopTrace(service,f);trace.stage('controlled-thermal-stop');const heater=service.printer.hardware.thermal[0],cause=new Error('Controlled grid thermal source stop');
  // This control tests the retained source, not the original remote trigger.
  await heater.runtime.shutdown(cause);await service.printer.group.stop(cause);
  assert.equal(heater.runtime.status.cause,cause);assert.equal(heater.runtime.status.target,0);assert(heater.runtime.status.outputStopConfirmed);
  const evidence=trace.snapshot() as any;assert(evidence.firstStop);assert.equal(evidence.firstStop.state.stage,'controlled-thermal-stop');
  assert(evidence.firstStop.state.thermal.some((h:any)=>h.cause?.message===cause.message));assert(evidence.thermal.some((h:any)=>h.cause?.message===cause.message));
  assert.equal(evidence.port.fault.message,'Native file motion stopped');assert.equal(evidence.group.fault.message,cause.message);
  assert.equal(evidence.group.state,'stopped');assert(evidence.clocks.every((c:any)=>c.state==='stopped'));assert.deepEqual(f.transport.stops,[1,1]);
  assert(f.transport.firmware.every(fw=>!fw.outputs.some(command=>command.name==='queue_step')));
  t.diagnostic(JSON.stringify({controlledGridStop:{...evidence,originalCIFaultCaptured:false}}));
 }catch(error){primary=error;throw error;}
 finally{trace?.close();const errors:unknown[]=[];for(const close of [()=>service?.close(),()=>profile?.release(),()=>f.close(),()=>rm(dir,{recursive:true,force:true})])try{await close();}catch(error){errors.push(error);}if(errors.length)throw new AggregateError([...primary===undefined?[]:[primary],...errors],'Grid stop control and cleanup failed',{cause:primary});}
});
