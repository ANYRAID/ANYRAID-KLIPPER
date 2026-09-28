import assert from 'node:assert/strict';
import {Bmp180Sensor} from '../src/thermal/bmp180.ts';
import {bmp180Device} from '../test/helpers/bmp180-device.ts';
const results=[];for(const oversampling of [0,1,2,3]){const samplesMs:number[]=[];for(let round=0;round<8;round++){
 let time=0,calls=0;const f=bmp180Device(()=>time),sensor=new Bmp180Sensor({async transfer(b,n){calls++;return f.exchange(0,b,n).data;}},oversampling,async ms=>{time+=ms;});await sensor.initialize(new AbortController().signal);const initial=calls,signal=new AbortController().signal;
 const start=performance.now();for(let i=0;i<100000;i++)await sensor.sample(signal);const elapsed=performance.now()-start;assert.equal(calls-initial,600000);assert.equal(f.state.conversions,200002);assert.equal(f.state.reads,200002);if(round>=3)samplesMs.push(elapsed);
 }const medianMs=[...samplesMs].sort((a,b)=>a-b)[2];assert(medianMs/100<=10,'BMP180 driver CPU overhead exceeds 10 microseconds/sample');results.push({oversampling,samplesMs,medianMs,microsecondsPerSample:medianMs/100});}
console.log(JSON.stringify({runtime:process.version,scope:'100000 complete forced samples per round with register simulator and virtual waits; 3 warmups and 5 retained rounds per oversampling setting; no electrical IO; not a Python comparison',maximumMicrosecondsPerSample:10,results},null,2));
