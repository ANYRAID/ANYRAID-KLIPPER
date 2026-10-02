import test from 'node:test';
import assert from 'node:assert/strict';
import {pressureAdvanceSettings,planPressureAdvance} from '../src/motion/pressure-advance-settings.ts';
import {pressureAdvanceCommand,bindPressureAdvanceCommand} from '../src/gcode/pressure-advance.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
import {configuredMotionFixture} from './helpers/configured-motion.ts';
test('pressure plans distinguish effective scan-window changes from continuous coefficient updates',()=>{
 const old={advance:.05,smoothTime:.04};for(const [next,kind,window] of [[{advance:.1,smoothTime:.04},'same-window',.04],[{advance:0,smoothTime:.04},'window-change',0],[{advance:.1,smoothTime:.02},'window-change',.02],[{advance:.1,smoothTime:0},'window-change',0]] as const){const plan=planPressureAdvance(old,next);assert.equal(plan.kind,kind);assert.equal(plan.nextWindow,window);assert.equal(plan.previousWindow,.04);assert(Object.isFrozen(plan)&&Object.isFrozen(plan.next));}
 assert.equal(planPressureAdvance({advance:0,smoothTime:.04},{advance:0,smoothTime:.1}).kind,'same-window');assert.equal(planPressureAdvance({advance:1,smoothTime:0},{advance:2,smoothTime:0}).kind,'same-window');assert.equal(planPressureAdvance({advance:0,smoothTime:.04},old).kind,'window-change');
});
test('command defaults, selected extruder and finite bounds are validated before application',()=>{
 const current={advance:.05,smoothTime:.04};assert.deepEqual(pressureAdvanceCommand({},current).next,current);assert.equal(pressureAdvanceCommand({ADVANCE:'０.１',EXTRUDER:'extruder'},current).next.advance,.1);assert.equal(pressureAdvanceCommand({SMOOTH_TIME:'0'},current).next.smoothTime,0);
 for(const params of [{ADVANCE:'-1'},{ADVANCE:'nan'},{ADVANCE:'inf'},{SMOOTH_TIME:'.201'},{SMOOTH_TIME:'1e-200'},{EXTRUDER:'other'}] as Record<string,string>[]) assert.throws(()=>pressureAdvanceCommand(params,current));assert.deepEqual(current,{advance:.05,smoothTime:.04});
 const plan=pressureAdvanceCommand({ADVANCE:'.1'},current);current.advance=.9;assert.equal(plan.previous.advance,.05);
});
test('numeric smoothing resolution fails during configuration before native allocation',()=>{
 assert.throws(()=>configuredMotionFixture({},{pressure_advance:'.05',pressure_advance_smooth_time:'1e-200'}).emitters(),/numeric resolution/);
 const disabled=configuredMotionFixture({},{pressure_advance:'0',pressure_advance_smooth_time:'1e-200'}).emitters()[1].pressureAdvance!;assert.deepEqual(disabled,{advance:0,smoothTime:1e-200});assert.throws(()=>pressureAdvanceCommand({ADVANCE:'.1'},disabled),/numeric resolution/);
 assert.deepEqual(pressureAdvanceSettings(.1,0),{advance:.1,smoothTime:0});
});
test('typed command admission waits for the owner and emits state only after success',async()=>{
 let current={advance:.05,smoothTime:.04},applied=0,following=false;const held=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>(),output:string[]=[],d=new GCodeDispatch({output:m=>output.push(m),shutdown(){}});
 bindPressureAdvanceCommand(d,{name:'extruder',get pressureAdvance(){return current;},async applyPressureAdvance(change,signal){entered.resolve();await held.promise;signal.throwIfAborted();current={...change.next};applied++;}});d.register('AFTER',()=>{following=true;});d.setReady(true);
 const running=d.execute('SET_PRESSURE_ADVANCE ADVANCE=0.1\nAFTER');await entered.promise;assert.equal(applied,0);assert.equal(following,false);assert.equal(output.length,0);held.resolve();await running;assert.equal(applied,1);assert.equal(following,true);assert(output.join('').includes('pressure_advance: 0.100000'));assert(output.join('').includes('pressure_advance_smooth_time: 0.040000'));
 await assert.rejects(d.execute('SET_PRESSURE_ADVANCE ADVANCE=-1'));assert.equal(applied,1);assert.equal(current.advance,.1);
});
test('cancellation does not publish a success report or admit a following command',async()=>{
 let following=false,applied=false;const gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>(),reports:string[]=[],d=new GCodeDispatch({output:m=>reports.push(m),shutdown(){}});
 bindPressureAdvanceCommand(d,{name:'extruder',pressureAdvance:{advance:.05,smoothTime:.04},async applyPressureAdvance(_change,signal){entered.resolve();await gate.promise;signal.throwIfAborted();applied=true;}});d.register('AFTER',()=>{following=true;});d.setReady(true);const run=d.execute('SET_PRESSURE_ADVANCE ADVANCE=0.1\nAFTER');void run.catch(()=>{});await entered.promise;d.emergencyStop('test cancel');gate.resolve();await assert.rejects(run);assert.equal(applied,false);assert.equal(following,false);assert(!reports.some(m=>m.includes('pressure_advance:')));
});
