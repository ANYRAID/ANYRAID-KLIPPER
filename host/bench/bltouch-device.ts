import assert from 'node:assert/strict';
import {BLTouchDevice,type BLTouchDevicePort} from '../src/homing/bltouch-device.ts';
const times:number[]=[];let seeks=0,writes=0,checks=0;
for(let batch=0;batch<9;batch++){
 let time=1;const port:BLTouchDevicePort={clockAt:t=>BigInt(Math.trunc(t*1e6)),secondsToClock:t=>BigInt(Math.trunc(t*1e6)),printAt:c=>Number(c)/1e6,estimatedPrintTime:()=>time,motionPrintTime:()=>time,async waitUntil(t){time=Math.max(time,t);},async verifyState(o){time=Math.max(time,o.until);checks++;return true;},async setPWM(){writes++;},async stop(){throw Error('unexpected stop');}};
 const device=new BLTouchDevice(port,{pinMoveTime:.68,stowOnEachSample:true,touchMode:false,pinUpNotTriggered:true,pinUpTouchTriggered:true,outputMode:null}),signal=new AbortController().signal;await device.initialize(signal);
 const start=performance.now();for(let i=0;i<1000;i++)await device.session(sample=>sample(async(_s,onTriggered)=>{await onTriggered();seeks++;return 0;}),signal);if(batch>=2)times.push(performance.now()-start);assert.equal(device.status.phase,'idle');
}
times.sort((a,b)=>a-b);assert.equal(seeks,9000);assert(times[6]/1000<1,'BLTouch lifecycle CPU overhead must stay below 1ms per simulated sample');
console.log(JSON.stringify({node:process.version,iterations:1000,warmups:2,samples:7,medianMs:times[3],maxMs:times[6],maxPerSampleMs:times[6]/1000,seeks,writes,checks,scope:'Trigger callback and lifecycle CPU/promise overhead only; in-memory clock/verification/seek ports, no physical wait, serial I/O or printer acceptance.'}));
