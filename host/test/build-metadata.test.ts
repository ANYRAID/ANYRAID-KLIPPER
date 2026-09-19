import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BuildMetadata} from '../src/build/metadata.ts';
test('metadata handles range-expanded pins, static deduplication and task polling',()=>{
 const b=new BuildMetadata();for(const line of ['DECL_ENUMERATION_RANGE pin PA0 0x10 4','DECL_INITIAL_PINS " PA1, !PA3 "','_DECL_STATIC_STR timer too close','_DECL_STATIC_STR timer too close','_DECL_CALLLIST ctr_run_taskfuncs run_tasks'])assert.equal(b.accept(line),true);
 assert.deepEqual(b.dictionary(),{enumerations:{pin:{PA0:[16,4]},static_string_id:{'timer too close':2}},config:{INITIAL_PINS:'PA1,!PA3'}});
 const code=b.generate();assert.match(code,/\{17, IP_OUT_HIGH\}/);assert.match(code,/\{19, 0\}/);assert.equal(code.split('irq_poll();').length-1,2);
 assert.equal(b.accept('DECL_COMMAND_FLAGS other'),false);
});
test('metadata conflicts and unknown pins fail instead of silently producing output',()=>{
 const b=new BuildMetadata();b.accept('DECL_CONSTANT CLOCK_FREQ 100');b.accept('DECL_CONSTANT CLOCK_FREQ 100');assert.throws(()=>b.accept('DECL_CONSTANT CLOCK_FREQ 101'));
 b.accept('DECL_ENUMERATION pin PA0 0');assert.throws(()=>b.accept('DECL_ENUMERATION pin PA0 1'));
 b.accept('DECL_INITIAL_PINS "PA1"');assert.throws(()=>b.generate(),/Unknown initial pin/);
 assert.throws(()=>b.accept('DECL_CONSTANT INVALID 9007199254740993'));
});
test('IRQ table is emitted only with reset, catches conflicts and rejects invalid slots',()=>{
 const b=new BuildMetadata();b.accept('DECL_ARMCM_IRQ TimerHandler 5');assert.ok(!b.generate().includes('VectorTable'));
 b.accept('DECL_ARMCM_IRQ ResetHandler -15');const code=b.generate();assert.match(code,/&_stack_end/);assert.match(code,/TimerHandler,/);
 assert.throws(()=>b.accept('DECL_ARMCM_IRQ OtherHandler 5'));b.accept('DECL_ARMCM_IRQ InvalidHandler -16');assert.throws(()=>b.generate());
});
