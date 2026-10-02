import assert from 'node:assert/strict';
import {Bme280Sensor} from '../src/thermal/bme280.ts';
import {bme280Device} from '../test/helpers/bme280-device.ts';
const results=[];for(const humidity of [false,true]){const samplesMs:number[]=[];for(let round=0;round<8;round++){
 let time=0,calls=0;const f=bme280Device(humidity,()=>time),sensor=new Bme280Sensor({async transfer(b,n){calls++;return f.exchange(0,b,n).data;}},{temperature:2,pressure:2,humidity:2,filter:1},async ms=>{time+=ms;});await sensor.initialize(new AbortController().signal);const initial=calls,signal=new AbortController().signal;
 const start=performance.now();for(let i=0;i<100000;i++)await sensor.sample(signal);const elapsed=performance.now()-start;assert.equal(calls-initial,400000);assert.equal(f.state.conversions,100001);assert.equal(f.state.reads,100001);if(round>=3)samplesMs.push(elapsed);
 }const medianMs=[...samplesMs].sort((a,b)=>a-b)[2];assert(medianMs/100<=10,'BME driver CPU overhead exceeds 10 microseconds/sample');results.push({chip:humidity?'BME280':'BMP280',samplesMs,medianMs,microsecondsPerSample:medianMs/100});}
console.log(JSON.stringify({runtime:process.version,scope:'100000 complete forced samples per round with register simulator and virtual waits; 3 warmups and 5 retained rounds per chip; no electrical IO; not a Python comparison',maximumMicrosecondsPerSample:10,results},null,2));
