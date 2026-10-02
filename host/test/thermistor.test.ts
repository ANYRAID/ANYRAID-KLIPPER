import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Thermistor} from '../src/thermal/thermistor.ts';
import {ADCTemperature} from '../src/thermal/adc.ts';
import {TemperatureState} from '../src/thermal/state.ts';
test('Beta calibration and Steinhart-Hart return specified calibration temperatures',()=>{
 const beta=new Thermistor(4700,0,{point:[25,100000],beta:3950});assert.ok(Math.abs(beta.temperature(100000/104700)-25)<1e-10);
 const points=[[20,126800],[150,1360],[300,80.65]] as const,t=new Thermistor(4700,0,{points});
 for(const [temperature,resistance] of points)assert.ok(Math.abs(t.temperature(resistance/(4700+resistance))-temperature)<1e-10);
 for(let temp=0;temp<=300;temp+=.5)assert.ok(Math.abs(t.temperature(t.adc(temp))-temp)<1e-9);
});
test('inline resistance is removed and malformed or nonphysical calibration is rejected',()=>{
 const t=new Thermistor(4700,100,{point:[25,100000],beta:3950});assert.ok(Math.abs(t.temperature(t.adc(250))-250)<1e-10);
 assert.throws(()=>t.temperature(0));assert.throws(()=>t.temperature(NaN));assert.throws(()=>t.adc(Infinity));
 assert.throws(()=>new Thermistor(4700,0,{points:[[25,100000],[25,1000],[200,100]]}));assert.throws(()=>new Thermistor(4700,0,{point:[-273.15,100000],beta:3950}));
});
test('ADC adapter preserves last-sample timestamp offset and faults raw open/short values',()=>{
 const t=new Thermistor(4700,0,{point:[25,100000],beta:3950});
 for(const raw of [0,1,NaN]) {
  const state=new TemperatureState({minimum:0,maximum:300,minimumExtrude:170,smoothTime:1});
  const adc=new ADCTemperature(t,0,300,(time,temp)=>state.sample(time,temp),reason=>state.shutdown(reason));
  adc.receive([[1,t.adc(25)],[2,t.adc(200)]]);assert.equal(state.state.lastTime,2.008);assert.equal(state.status(2.008).canExtrude,true);
  assert.throws(()=>adc.receive([[3,raw]]));assert.equal(state.status(3).canExtrude,false);assert.throws(()=>adc.receive([[4,t.adc(200)]]));
  assert.deepEqual([adc.sampling.sampleCount,adc.sampling.sampleTime,adc.sampling.reportTime,adc.sampling.rangeCheckCount],[8,.001,.3,4]);
 }
});
