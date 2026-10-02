import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ADCTemperature} from '../src/thermal/adc.ts';
const converter={adc:(t:number)=>t/1000,temperature:(v:number)=>v*1000};
test('ADC diagnostics retain last attempted raw report, bounds and isolated snapshots',()=>{
 const received:number[][]=[];const reasons:string[]=[];
 const adc=new ADCTemperature(converter,10,300,(...sample)=>received.push(sample),r=>reasons.push(r));
 assert.equal(adc.status.readTime,null);
 adc.receive([[1,.02],[2,.2]]);
 assert.deepEqual(received,[[2.008,200]]);
 const status=adc.status;status.rawValue=1;assert.equal(adc.status.rawValue,.2);
 assert.throws(()=>adc.receive([[3,.4]]),/outside configured range/);
 assert.deepEqual(adc.status,{stopped:true,faultCode:'out-of-range',readTime:3,rawValue:.4,temperature:null,estimatedTemperature:400,minimumTemperature:10,maximumTemperature:300,minimumADC:.01,maximumADC:.3});
 assert.deepEqual(reasons,['ADC temperature sensor failed: out-of-range']);
 assert.equal(received.length,1);assert.throws(()=>adc.receive([[4,.1]]),/stopped/);assert.equal(adc.status.readTime,3);
});
test('ADC malformed reports do not attribute a prior good temperature to the fault',()=>{
 for(const [samples,code] of [[[],'invalid-batch'],[[[NaN,.2]],'invalid-time'],[[[3,Infinity]],'out-of-range']] as const){
  const adc=new ADCTemperature(converter,10,300,()=>{},()=>{});
  adc.receive([[1,.2]]);assert.throws(()=>adc.receive(samples));
  assert.equal(adc.status.faultCode,code);assert.equal(adc.status.temperature,null);
  assert.equal(adc.status.estimatedTemperature,null);assert.doesNotThrow(()=>JSON.stringify(adc.status));
 }
});
test('ADC rejects nonfinite conversion and keeps original cause when shutdown also throws',()=>{
 for(const value of [NaN,Infinity,-Infinity]){
  let delivered=false;let stopped=false;
  const adc=new ADCTemperature({...converter,temperature:()=>value},10,300,()=>{delivered=true;},()=>{stopped=true;});
  assert.throws(()=>adc.receive([[1,.2]]),/not finite/);assert.equal(delivered,false);assert.equal(stopped,true);assert.equal(adc.status.faultCode,'conversion');
 }
 const cause=new Error('control callback failed'),stop=new Error('output failed');
 const adc=new ADCTemperature(converter,10,300,()=>{throw cause;},()=>{throw stop;});
 assert.throws(()=>adc.receive([[1,.2]]),(error:unknown)=>{assert.ok(error instanceof AggregateError);assert.equal(error.cause,cause);assert.deepEqual(error.errors,[cause,stop]);return true;});
 assert.equal(adc.fault,cause);assert.equal(adc.stopError,stop);assert.equal(adc.status.faultCode,'callback');assert.equal(adc.status.temperature,200);
});
test('Diagnostic conversion failure cannot escape or restart a stopped sensor',()=>{
 let calls=0;
 const adc=new ADCTemperature({...converter,temperature:()=>{calls++;throw new Error('not convertible');}},10,300,()=>assert.fail('unexpected callback'),()=>{});
 assert.throws(()=>adc.receive([[1,0]]));assert.equal(calls,0);
 assert.equal(adc.status.estimatedTemperature,null);assert.equal(calls,1);
 assert.throws(()=>adc.receive([[2,.2]]),/stopped/);
});
