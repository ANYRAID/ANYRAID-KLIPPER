import test from 'node:test';
import assert from 'node:assert/strict';
import {emitClientTemperatures} from './helpers/client-temperature.ts';
test('client ADC fixture emits only to live MCU readers and preserves wrapping clocks',()=>{
 const calls:{index:number;clock:number}[]=[],stops=[0,0];const devices=[0,1].map(index=>({outputs:[{name:'query_analog_in',parameters:{oid:3,sample_count:8,sample_ticks:10,rest_ticks:100}}],currentClock:()=>0xffffffff,emit(_name:string,p:{oid:number;next_clock:number;values:Buffer}){assert.equal(p.oid,3);assert.equal(p.values.length,2);calls.push({index,clock:p.next_clock});}}));
 emitClientTemperatures(devices,stops);assert.deepEqual(calls,[{index:0,clock:19},{index:1,clock:19}]);calls.length=0;stops[0]++;emitClientTemperatures(devices,stops);assert.deepEqual(calls,[{index:1,clock:19}]);calls.length=0;stops[1]++;for(let i=0;i<1000;i++)emitClientTemperatures(devices,stops);assert.deepEqual(calls,[]);
});
