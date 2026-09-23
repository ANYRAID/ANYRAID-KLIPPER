import assert from 'node:assert/strict';
import {compileConfiguredAnalogHeaters} from '../src/config/analog-heater.ts';
import {stepperBatchFixture} from '../test/helpers/configured-steppers.ts';
import {heaterReader,heaterClocks} from '../test/helpers/configured-heater.ts';
import {mcuOids} from '../src/protocol/mcu-oids.ts';
const reader=heaterReader({control:'pid',pid_kp:'22',pid_ki:'1',pid_kd:'80'}),clocks=heaterClocks(),wall:number[]=[],cpu:number[]=[];
for(let run=0;run<14;run++){
 const start=performance.now(),used=process.cpuUsage();
 for(let i=0;i<500;i++){const f=stepperBatchFixture(),[p]=compileConfiguredAnalogHeaters(reader,f.pins,f.mcus,clocks,[{section:'extruder'}]);assert.equal(p.output.pwm.maximumDuration,3);assert.equal(p.sensor.adc.maximumSum,32760);assert.equal(f.pins.claimedPins.length,2);assert.equal(mcuOids(f.pins).finalize('mcu').oidCount,2);}
 const elapsed=(performance.now()-start)/500,usage=process.cpuUsage(used);if(run>=3){wall.push(elapsed);cpu.push((usage.user+usage.system)/500000);}
}
const stats=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[5],p95Ms:v[10]};},timing=stats(wall),usage=stats(cpu);console.log(JSON.stringify({node:process.version,samples:11,batchesPerSample:500,wall:timing,cpu:usage,scope:'Fresh dictionary, sensor registry, PID configuration, PWM/ADC compile and pin/OID claims; no MCU IO.'}));assert(timing.medianMs<2&&usage.medianMs<2,'Analog heater startup exceeded 2 ms per batch');
