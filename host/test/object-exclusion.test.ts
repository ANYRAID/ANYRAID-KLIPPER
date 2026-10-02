import test from 'node:test';
import assert from 'node:assert/strict';
import {ObjectExclusionTransform} from '../src/gcode/object-exclusion.ts';
import {objectExclusionReference} from './helpers/object-exclusion-reference.ts';
test('all motion states and admitted paths match frozen original Python across exclusion/retraction/reset cycles',()=>{
 const {actions,expected,metadata}=objectExclusionReference();let physical=[0,0,0,0];const moves:any[]=[];
 const transform=new ObjectExclusionTransform({position:()=>physical,move(p,s){physical=[...p];moves.push([[...p],s]);}});let total=0;
 for(let i=0;i<actions.length;i++){
  const a=actions[i],before=moves.length,previousE=physical[3];let value:null|number[]=null;
  switch(a.kind){case 'reset':transform.reset();break;case 'exclude':transform.exclude(a.name);break;case 'unexclude':transform.unexclude(a.name);break;case 'start':transform.start(a.name);break;case 'end':transform.end();break;case 'position':value=transform.position();break;case 'move':{const receipt=transform.move(a.position,a.speed);assert.equal(receipt.admitted,moves.length>before);assert.equal(receipt.extrusionDelta,physical[3]-previousE);total+=receipt.extrusionDelta;break;}default:assert.fail();}
  assert.deepEqual({state:transform.state,moves:moves.slice(before),position:value},expected[i],'action '+i);
 }
 assert.equal(moves.length,metadata.admittedMoves);assert.equal(actions.length,7583);assert(Number.isFinite(total));
});
test('rejected exit motion preserves offsets, retraction correction and warmup for a retry',()=>{
 let physical=[0,0,0,0],reject=false,moves=0;const t=new ObjectExclusionTransform({position:()=>physical,move(p){if(reject)throw Error('rejected');physical=[...p];moves++;}});t.exclude('B');t.start('A');
 for(let i=1;i<=5;i++)t.move([i,0,0,i],10);t.start('B');t.move([10,0,.2,10],10);t.move([10,0,.2,9.7],10);t.end();
 const before=t.state;reject=true;assert.throws(()=>t.move([11,1,.2,9.8],10),/rejected/);assert.deepEqual(t.state,before);assert.equal(moves,5);
 reject=false;const receipt=t.move([11,1,.2,9.8],10);assert(receipt.admitted);assert.equal(moves,6);assert.equal(receipt.extrusionDelta,physical[3]-5);
 const copy=t.state!;copy.offset[3]=999;assert.notEqual(t.state!.offset[3],999);
});
test('invalid motion, capacity and arithmetic overflow cannot partially change exclusion history',()=>{
 const t=new ObjectExclusionTransform({position:()=>[0,0,0,0],move(){}});t.exclude('B');t.start('A');for(let i=1;i<=5;i++)t.move([i,0,0,i],10);t.start('B');const before=t.state;
 for(const [p,s] of [[[0,0,0,NaN],10],[[0,0,0],10],[[0,0,0,0],-1]] as const)assert.throws(()=>t.move(p,s));assert.deepEqual(t.state,before);
 t.move([1e308,0,0,6],10);t.end();t.move([1e308,0,0,6],10);t.start('B');const unchanged=t.state;assert.throws(()=>t.move([-1e308,0,0,7],10),/overflow/);assert.deepEqual(t.state,unchanged);
 for(let i=0;i<1023;i++)t.exclude('item'+i);assert.throws(()=>t.exclude('overflow'),/capacity/);t.exclude('B');t.unexclude();assert.deepEqual(t.status.excluded_objects,[]);assert(t.active);t.reset();assert(!t.active);
});

test('G-code coordinates advance through skipped objects while accounting uses only admitted extrusion',async()=>{
 const {GCodeMove}=await import('../src/gcode/move.ts');let physical=[0,0,0,0];const port={position:()=>physical,move(p:readonly number[]){physical=[...p];}},coordinates=new GCodeMove(port),filter=new ObjectExclusionTransform(port);
 coordinates.extrusionAccounting.begin();filter.exclude('B');coordinates.setPort(filter);filter.start('A');
 for(let i=1;i<=5;i++)coordinates.execute('G1',{X:i,E:i});assert.equal(coordinates.extrusionAccounting.filamentUsed,5);
 filter.start('B');coordinates.execute('G1',{X:10,E:10});assert.equal(coordinates.state.position[3],10);assert.equal(physical[3],5);assert.equal(coordinates.extrusionAccounting.filamentUsed,5);
 coordinates.execute('G1',{E:9.7});filter.end();coordinates.execute('G1',{X:20,E:10});assert.equal(coordinates.extrusionAccounting.filamentUsed,physical[3]);
 coordinates.execute('M221',{S:200});const before=physical[3],used=coordinates.extrusionAccounting.filamentUsed!;coordinates.temporaryExtrusion(.5,300);assert.equal(coordinates.extrusionAccounting.filamentUsed,used+(physical[3]-before)/2);
 filter.start('B');const saved=coordinates.extrusionAccounting.filamentUsed;coordinates.execute('SET_GCODE_OFFSET',{E_ADJUST:1,MOVE:1});assert.equal(coordinates.extrusionAccounting.filamentUsed,saved);
});
