import assert from 'node:assert/strict';
import {compileConfiguredHoming} from '../src/config/homing.ts';
import {mcuOids} from '../src/protocol/mcu-oids.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {stepperBatchFixture} from '../test/helpers/configured-steppers.ts';
const reader=new ConfigurationReader(new ConfigurationSource('/homing.cfg',{x:{endstop_pin:'^!PA4'},y:{endstop_pin:'^PA5'}},[]),null),requests=['x','y'].map(section=>({section,triggers:[{mcu:'aux'},{mcu:'mcu'}]})),wall:number[]=[],cpu:number[]=[];
for(let run=0;run<14;run++){
 const start=performance.now(),used=process.cpuUsage();
 for(let i=0;i<500;i++){const f=stepperBatchFixture(),plans=compileConfiguredHoming(reader,f.pins,f.mcus,requests);assert.equal(plans.length,2);assert.equal(plans[0].primary,1);assert.equal(f.pins.claimedPins.length,2);assert.equal(mcuOids(f.pins).finalize('mcu').oidCount,4);assert.equal(mcuOids(f.pins).finalize('aux').oidCount,2);}
 const elapsed=(performance.now()-start)/500,usage=process.cpuUsage(used);if(run>=3){wall.push(elapsed);cpu.push((usage.user+usage.system)/500000);}
}
const stats=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[5],p95Ms:v[10]};},timing=stats(wall),usage=stats(cpu);
console.log(JSON.stringify({node:process.version,samples:11,batchesPerSample:500,wall:timing,cpu:usage,scope:'Fresh dictionary and registries; two GPIO endstops and four trigger-sync objects over two MCUs; no IO.'}));assert(timing.medianMs<2&&usage.medianMs<2,'Homing startup assembly exceeded 2 ms per batch');
