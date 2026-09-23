import assert from 'node:assert/strict';
import {compileConfiguredCoolingFans} from '../src/config/cooling-fan.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {stepperBatchFixture} from '../test/helpers/configured-steppers.ts';
import {mcuOids} from '../src/protocol/mcu-oids.ts';
const reader=new ConfigurationReader(new ConfigurationSource('/fan.cfg',{fan:{pin:'!PA2',hardware_pwm:'true',enable_pin:'PA3'}},[]),null),clocks=new Map([['mcu',{currentPrintTime:1,calibration:{offset:0,frequency:1e6}}]]),wall:number[]=[],cpu:number[]=[];
for(let run=0;run<14;run++){
 const used=process.cpuUsage(),start=performance.now();
 for(let i=0;i<500;i++){const f=stepperBatchFixture(),[p]=compileConfiguredCoolingFans(reader,f.pins,f.mcus,clocks,[{section:'fan',minimumScheduleTime:.001}]);assert.equal(p.output.pwm.oid,0);assert.equal(p.enable!.pwm.oid,1);assert.equal(f.pins.claimedPins.length,2);assert.equal(mcuOids(f.pins).finalize('mcu').oidCount,2);}
 const elapsed=(performance.now()-start)/500,usage=process.cpuUsage(used);if(run>=3){wall.push(elapsed);cpu.push((usage.user+usage.system)/500000);}
}
const stats=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[5],p95Ms:v[10]};},timing=stats(wall),usage=stats(cpu);console.log(JSON.stringify({node:process.version,samples:11,batchesPerSample:500,wall:timing,cpu:usage,scope:'Fresh dictionary and registry; hardware cooling PWM plus software enable and generation validation; no MCU IO.'}));assert(timing.medianMs<2&&usage.medianMs<2,'Cooling fan startup exceeded 2 ms per batch');
