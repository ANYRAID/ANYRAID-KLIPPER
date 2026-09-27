import test from 'node:test';
import assert from 'node:assert/strict';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {planTmc220x,tmc220xCurrent} from '../src/drivers/tmc220x.ts';
import {Tmc220xCurrent} from '../src/drivers/tmc220x-current.ts';
import {bindTmcCurrent} from '../src/gcode/tmc-current.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
const plan=()=>planTmc220x(new ConfigurationReader(new ConfigurationSource('/current.cfg',{'tmc2209 stepper_x':{run_current:'.4',hold_current:'.3'},stepper_x:{microsteps:'16',rotation_distance:'40'}},[]),null),'tmc2209 stepper_x');
const signal=()=>new AbortController().signal;
test('updates preserve unrelated bits and publish only after both acknowledgements',async()=>{
 const p=plan(),writes:number[][]=[],pending=Promise.withResolvers<void>();
 const owner=new Tmc220xCurrent({async write(r,v){writes.push([r,v]);if(r===0x10)await pending.promise;}},p,signal(),()=>assert.fail('fault'));
 const job=owner.set({run:1.5},signal());await new Promise(r=>setImmediate(r));assert.equal(owner.current,p.current);
 assert.deepEqual(writes.map(w=>w[0]),[0x6c,0x10]);
 assert.equal(writes[0][1]&~(1<<17),p.registers.find(r=>r.name==='CHOPCONF')!.value&~(1<<17));
 assert.equal(writes[1][1]&~0x1f1f,p.registers.find(r=>r.name==='IHOLD_IRUN')!.value&~0x1f1f);
 pending.resolve();await job;assert.deepEqual(owner.current,tmc220xCurrent(1.5,.3));
 await owner.set({hold:.2},signal());assert.deepEqual(owner.current,tmc220xCurrent(tmc220xCurrent(1.5,.3).runCurrent,.2));
 await owner.set({run:0},signal());assert(owner.current.runCurrent>0);
});
test('partial write failure retires owner without publishing or accepting retries',async()=>{
 const p=plan(),writes:number[]=[],faults:unknown[]=[];
 const owner=new Tmc220xCurrent({async write(r){writes.push(r);if(r===0x10)throw new Error('lost');}},p,signal(),e=>faults.push(e));
 await assert.rejects(owner.set({run:1.5},signal()),/lost/);assert.equal(owner.current,p.current);assert.equal(faults.length,1);
 await assert.rejects(owner.set({run:.5},signal()),/unavailable/);assert.deepEqual(writes,[0x6c,0x10]);
});
test('invalid changes and already cancelled requests do not touch hardware',async()=>{
 const abort=new AbortController(),owner=new Tmc220xCurrent({async write(){assert.fail('write');}},plan(),abort.signal,()=>assert.fail('fault'));
 for(const change of [{run:-1},{hold:0},{run:NaN}])await assert.rejects(owner.set(change,signal()));
 abort.abort();await assert.rejects(owner.set({run:1},signal()));
});
test('native command waits for drain and updates before subsequent movement',async()=>{
 const events:string[]=[],drained=Promise.withResolvers<void>(),owner=new Tmc220xCurrent({async write(){events.push('write');}},plan(),signal(),()=>assert.fail('fault'));
 const dispatch=new GCodeDispatch({output(){},shutdown(){assert.fail('shutdown');},async drain(){events.push('drain');await drained.promise;}});
 bindTmcCurrent(dispatch,[{section:'tmc2209 stepper_x',current:owner}]);dispatch.register('G1',()=>{events.push('move');});dispatch.setReady(true);
 const job=dispatch.execute('SET_TMC_CURRENT STEPPER=stepper_x CURRENT=1.5\nG1');await new Promise(r=>setImmediate(r));assert.deepEqual(events,['drain']);
 drained.resolve();await job;assert.deepEqual(events.slice(0,4),['drain','write','write','move']);
});
test('cancellation between register acknowledgements retires owner and prevents the second write',async()=>{
 const abort=new AbortController(),writes:number[]=[],faults:unknown[]=[],p=plan();
 const owner=new Tmc220xCurrent({async write(r){writes.push(r);abort.abort(new Error('cancel'));}},p,signal(),e=>faults.push(e));
 await assert.rejects(owner.set({run:1.5},abort.signal),/cancel/);assert.deepEqual(writes,[0x6c]);assert.equal(owner.current,p.current);assert.equal(faults.length,1);
});
