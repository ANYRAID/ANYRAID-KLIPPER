import test from 'node:test';
import assert from 'node:assert/strict';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {inputShaper} from '../src/motion/shaper.ts';
import type {StepperKinematics} from '../src/motion/step-compressor.ts';
const settings={frequency:1e6,timeOffset:0,oid:3,maxError:0,queueStepTag:5,directionTag:6};
const mirror={xScale:-1,xOffset:180,yScale:1,yOffset:0};
const rows=new Float64Array([1,.1,.8,.1,0,0,0,1,0,0,0,10,100,2,0,.1,0,9,0,0,0,0,0,0,0,0]);
function run(scale:number,shaped=false,split=false){
 using q=new TrapQueue();q.appendRaw(rows);using s=q.createStepper(settings,'x',.01);
 s.configureCarriage({...mirror,xScale:scale});if(shaped)s.configureShapers({x:inputShaper('mzv',40,.1)});
 assert.equal(s.commandedPosition,180);
 for(const t of split?[1.05,1.5,1.95,2.05]:[2.05])s.generate(t);
 return s.flush();
}
test('native carriage mirror, copy, inactive and scaled counts are exact',()=>{
 for(const scale of [-1,0,1,2])assert.equal(run(scale).position,BigInt(900*scale));
});
test('shaper wraps carriage without losing offset or chunk equivalence',()=>{
 for(const scale of [-1,0,1,2]){const full=run(scale,true);assert.equal(full.position,BigInt(900*scale));assert.deepEqual(run(scale,true,true),full);}
});
test('carriage projection preserves coupled axes',()=>{
 for(const mode of ['x','y','z','corexy+','corexy-','corexz+','corexz-'] as const){
  using q=new TrapQueue();using s=q.createStepper(settings,mode,.01);
  s.configureCarriage(mirror);const expected={x:175,y:7,z:11,'corexy+':182,'corexy-':168,'corexz+':186,'corexz-':164};
  assert.equal(s.coordinatePosition(5,7,11),expected[mode]);
 }
});
test('invalid or reordered transforms reject before mutation',()=>{
 using q=new TrapQueue();q.appendRaw(rows);using s=q.createStepper(settings,'x',.01);
 assert.throws(()=>s.configureCarriage({...mirror,xScale:NaN}),/Nonfinite/);
 assert.equal(s.commandedPosition,0);
 assert.throws(()=>s.configureCarriage({...mirror,xOffset:1e30}),/resolution/);
 s.configureCarriage(mirror);assert.throws(()=>s.configureCarriage(mirror),/once/);
 const snapshot=s.recoveryFilters();snapshot.carriage!.xOffset=0;assert.equal(s.recoveryFilters().carriage!.xOffset,180);
 s.generate(2.05);assert.throws(()=>s.configureCarriage(mirror),/once/);assert.equal(s.flush().position,-900n);
 using shaped=q.createStepper(settings,'x',.01);shaped.configureShapers({});assert.throws(()=>shaped.configureCarriage(mirror),/before/);
 for(const mode of ['extruder',{kind:'delta',armLength:250,towerX:0,towerY:0}] as StepperKinematics[]){using other=q.createStepper(settings,mode,.01);assert.throws(()=>other.configureCarriage(mirror),/before/);}
});
test('carriage ownership survives queue disposal and repeated shaper replacement',()=>{
 for(let i=0;i<100;i++){const q=new TrapQueue(),s=q.createStepper(settings,'corexy-',.01);s.configureCarriage(mirror);s.configureShapers({x:inputShaper('mzv',40,.1)});s.configureShapers({});assert.throws(()=>q.dispose(),/Detach/);assert.equal(s.coordinatePosition(5,7,0),168);s.dispose();s.dispose();q.dispose();}
});

test('scaled motion cannot bypass native rate admission',()=>{
 for(const shaped of [false,true]){
  using q=new TrapQueue();q.appendRaw(rows);using s=q.createStepper({...settings,frequency:10000},'x',.01);
  s.configureCarriage({...mirror,xScale:100});if(shaped)s.configureShapers({x:inputShaper('mzv',40,.1)});
  assert.throws(()=>s.generate(2.05),/rate|spacing|tick|budget|resolution/i);assert.equal(s.commandedPosition,180);
 }
});

test('affine wrapper matches physically transformed native paths including coupled axes',()=>{
 for(const mode of ['x','corexy+','corexy-','corexz+','corexz-'] as const)for(const scale of [-1,0,1,2]){
  // Diagonal source keeps the second axis moving even when the carriage parks.
  const source=new Float64Array([1,0,1,0,0,0,0,.6,.8,0,10,10,0]);
  using logical=new TrapQueue();logical.appendRaw(source);using wrapped=logical.createStepper(settings,mode,.01);
  wrapped.configureCarriage({...mirror,xScale:scale});wrapped.generate(2);const actual=wrapped.flush();
  const physical=source.slice();physical[4]=180;physical[7]=.6*scale;
  using direct=new TrapQueue();direct.appendRaw(physical);using reference=direct.createStepper(settings,mode,.01,[180,0,0]);reference.generate(2);
  assert.deepEqual(actual,reference.flush(),`${mode} scale ${scale}`);
 }
});
