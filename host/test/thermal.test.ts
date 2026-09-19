import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PIDControl,BangBangControl,HeaterPWM} from '../src/thermal/control.ts';
const pid=()=>new PIDControl({kp:22,ki:1.08,kd:114,smoothTime:1,maxPower:.8});
test('PID saturation prevents integral windup, finite samples update transactionally',()=>{
 const p=pid();assert.equal(p.update(.1,25,200),.8);assert.equal(p.state.integral,0);
 p.update(.2,199,200);const before=p.state;
 for(const args of [[.2,200,200],[.1,200,200],[.3,NaN,200],[.3,200,-1]] as [number,number,number][])assert.throws(()=>p.update(...args));
 assert.deepEqual(p.state,before);assert.throws(()=>new PIDControl({kp:1,ki:-1,kd:0,smoothTime:1,maxPower:1}));
});
test('PID derivative filter settles and zero Ki remains finite',()=>{
 const p=new PIDControl({kp:22,ki:0,kd:114,smoothTime:1,maxPower:1});
 for(let i=1;i<=200;i++)p.update(i*.1,200,200);
 assert.equal(p.state.integral,0);assert.equal(p.busy(200,200),false);assert.equal(p.busy(198,200),true);
});
test('bang-bang retains hysteresis at both inclusive thresholds',()=>{
 const p=new BangBangControl(.7,2);assert.equal(p.update(1,98,100),.7);assert.equal(p.update(2,101,100),.7);
 assert.equal(p.update(3,102,100),0);assert.equal(p.update(4,99,100),0);assert.equal(p.busy(98,100),false);
});
test('PWM requires live heartbeat, schedules renewals, and never suppresses off',()=>{
 const p=new HeaterPWM(1,.3);assert.equal(p.update(.1,1,200),undefined);p.heartbeat(0);
 assert.deepEqual(p.update(.2,1,200),{time:.5,power:1});assert.equal(p.update(.3,.99,200),undefined);
 assert.deepEqual(p.update(3,.02,200),{time:3.3,power:.02});assert.deepEqual(p.update(3.1,0,0),{time:3.4,power:0});
 assert.equal(p.update(6,1,200),undefined);p.heartbeat(6);assert.deepEqual(p.update(6.1,1,200),{time:6.3999999999999995,power:1});
 p.shutdown();assert.equal(p.update(6.2,1,200)?.power,0);assert.throws(()=>p.heartbeat(7));
});
