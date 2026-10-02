import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HeaterCheck} from '../src/thermal/verify.ts';
import {HeaterPWM} from '../src/thermal/control.ts';
test('failed warmup reaches deadline then latches failure on the following check',()=>{
 const c=new HeaterCheck({checkGainTime:3});for(let t=0;t<=3;t++)assert.equal(c.check(t,25,200),t+1);
 assert.equal(c.state.approaching,false);assert.equal(c.check(4,25,200),Infinity);assert.equal(c.state.faulted,true);
 assert.equal(c.check(5,200,0),Infinity);
});
test('heating gain renews deadline and target attainment resets accumulated error',()=>{
 const c=new HeaterCheck({checkGainTime:3});c.check(0,25,200);c.check(1,28,200);assert.equal(c.state.error,0);assert.equal(c.state.goalTime,4);
 c.check(2,197,200);assert.equal(c.state.approaching,false);assert.equal(c.state.error,0);
});
test('maintained-temperature loss accumulates error while target changes start a new approach',()=>{
 const c=new HeaterCheck({maxError:10});c.check(0,200,200);c.check(1,190,200);assert.equal(c.state.error,5);assert.equal(c.check(2,190,200),Infinity);
 const d=new HeaterCheck({maxError:0});d.check(0,200,200);assert.equal(d.check(1,200,220),2);assert.equal(d.state.approaching,true);
 d.check(2,200,0);assert.equal(d.state.approaching,false);assert.equal(d.state.lastTarget,0);
});
test('initial cooling lowers gain goal and invalid input leaves verification state unchanged',()=>{
 const c=new HeaterCheck();c.check(0,30,200);c.check(1,25,200);assert.equal(c.state.goalTemperature,27);
 const before=c.state;assert.throws(()=>c.check(1,25,200));assert.throws(()=>c.check(2,NaN,200));assert.deepEqual(c.state,before);
 assert.throws(()=>new HeaterCheck({heatingGain:0}));
});
test('verification fault revokes PWM authorization in the caller integration',()=>{
 const c=new HeaterCheck({checkGainTime:1,maxError:1}),pwm=new HeaterPWM(1,.3);pwm.heartbeat(0);
 assert.equal(pwm.update(.1,1,200)?.power,1);c.check(0,25,200);c.check(1,25,200);
 if(c.check(2,25,200)===Infinity)pwm.shutdown();assert.equal(pwm.update(2.1,1,200)?.power,0);assert.throws(()=>pwm.heartbeat(3));
});
