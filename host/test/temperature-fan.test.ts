import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {TemperatureFanControl} from '../src/thermal/temperature-fan.ts';
const reference=JSON.parse(readFileSync(new URL('../contracts/temperature-fan-reference.json',import.meta.url),'utf8'));
const settings=reference.settings;
const control=(maximumSpeed=1)=>new TemperatureFanControl({...settings,minimumSpeed:0,maximumSpeed},{kind:'watermark',delta:2},.3);
test('one-second host sensor report delay is preserved',()=>{
 const fan=new TemperatureFanControl(settings,{kind:'watermark',delta:2},1);
 assert.deepEqual(fan.sample(1,50),{time:2,speed:1});
});
test('480 samples match actual legacy PID and watermark output and internal precision',()=>{
 for(const c of reference.cases){
  const fan=new TemperatureFanControl(settings,c.algorithm,reference.reportDelay);
  for(const row of c.samples){
   assert.deepEqual(fan.sample(row.time,row.temperature)??null,row.event);
   assert.equal(fan.state.derivative,row.derivative);assert.equal(fan.state.integral,row.integral);
  }
 }
});
test('hysteresis retains cooling state within the band and refreshes after its deadline',()=>{
 const fan=control();assert.equal(fan.sample(1,38),undefined);
 assert.equal(fan.sample(2,41.999),undefined);assert.deepEqual(fan.sample(3,42),{time:3.3,speed:1});
 assert.equal(fan.sample(4,39),undefined);assert.deepEqual(fan.sample(8,39),{time:8.3,speed:1});
 assert.deepEqual(fan.sample(9,38),{time:9.3,speed:0});
});
test('target off and lower speed ceiling cannot be hidden by small-change suppression',()=>{
 const fan=control(.06);assert.equal(fan.sample(1,50)?.speed,.06);
 fan.configure({maximumSpeed:.02});assert.equal(fan.sample(2,50)?.speed,.02);
 fan.configure({target:0});assert.equal(fan.sample(3,50)?.speed,0);
 const cold=control(.06);cold.sample(1,50);cold.configure({maximumSpeed:.02});cold.sample(2,50);
 assert.equal(cold.sample(3,20)?.speed,0);
});
test('invalid multi-field requests are atomic and omitted target is preserved',()=>{
 const fan=control();fan.configure({target:45});const before=fan.settings;
 for(const update of [{target:50,minimumSpeed:.9,maximumSpeed:.5},{target:NaN},{maximumSpeed:Infinity},{target:101},{maximumSpeed:-1}]){
  assert.throws(()=>fan.configure(update));assert.deepEqual(fan.settings,before);
 }
 fan.configure({maximumSpeed:.5});assert.equal(fan.settings.target,45);
});
test('bad sensor values, duplicate time and exhausted clocks do not mutate control state',()=>{
 const fan=control();fan.sample(1,50);const before=fan.state;
 for(const [time,temp] of [[1,40],[0,40],[2,NaN],[2,101],[2,-21],[Infinity,40],[Number.MAX_VALUE,40]]){
  assert.throws(()=>fan.sample(time!,temp!));assert.deepEqual(fan.state,before);
 }
});
test('PID saturation freezes integral and finite inputs cannot silently overflow',()=>{
 const fan=new TemperatureFanControl(settings,{kind:'pid',kp:255,ki:255,kd:0,derivativeTime:2},.3);
 fan.sample(1,25);assert.equal(fan.state.integral,0);
 fan.sample(2,39.9);assert.ok(fan.state.integral>0);
 const overflow=new TemperatureFanControl({...settings,maximumTemperature:1e308},{kind:'pid',kp:Number.MAX_VALUE,ki:0,kd:0,derivativeTime:2},.3);
 const before=overflow.state;assert.throws(()=>overflow.sample(1,1e308));assert.deepEqual(overflow.state,before);
});
