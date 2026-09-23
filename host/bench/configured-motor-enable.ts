import assert from 'node:assert/strict';
import {compileConfiguredMotorEnables} from '../src/config/motor-enable.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import type {MCUGroup} from '../src/runtime/mcu-group.ts';
import {mcuOids} from '../src/protocol/mcu-oids.ts';
import {stepperBatchFixture} from '../test/helpers/configured-steppers.ts';
const reader=new ConfigurationReader(new ConfigurationSource('/motors.cfg',{x:{enable_pin:'!PA3'},y:{enable_pin:'!PA3_ALIAS'}},[]),null),requests=['x','y'].map(id=>({section:id,emitter:id,mcu:'mcu',leadTime:.001,calibration:{offset:0,frequency:1e6}}));
const wall:number[]=[],cpu:number[]=[];
for(let run=0;run<14;run++){
 const start=performance.now(),used=process.cpuUsage();
 for(let i=0;i<500;i++){
  const f=stepperBatchFixture(),session={dictionary:f.dictionary},group={session:()=>session} as unknown as MCUGroup;
  const plans=compileConfiguredMotorEnables(reader,f.pins,group,requests).lines;assert.equal(plans.length,1);assert.equal(plans[0].emitters.length,2);assert.equal(f.pins.claimedPins.length,1);assert.equal(mcuOids(f.pins).finalize('mcu').oidCount,1);
 }
 const elapsed=(performance.now()-start)/500,usage=process.cpuUsage(used);if(run>=3){wall.push(elapsed);cpu.push((usage.user+usage.system)/500000);}
}
const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[5],p95Ms:values[10]};},timing=stats(wall),usage=stats(cpu);
console.log(JSON.stringify({node:process.version,samples:11,batchesPerSample:500,wall:timing,cpu:usage,scope:'Fresh dictionary and pin/OID registry; two motors sharing one physical enable; configuration only, no IO.'}));
assert(timing.medianMs<2&&usage.medianMs<2,'Shared motor enable startup exceeded 2 ms per batch');
