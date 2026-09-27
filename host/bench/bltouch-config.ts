import assert from 'node:assert/strict';
import {compileConfiguredHardware,type HardwareLayout} from '../src/config/hardware.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {hardwareFixture,hardwareClocks} from '../test/helpers/configured-hardware.ts';
const reader=new ConfigurationReader(new ConfigurationSource('/bltouch.cfg',{bltouch:{sensor_pin:'^PA0',control_pin:'aux:PA1',z_offset:'1.5'}},[]),null),f=hardwareFixture(),clocks=hardwareClocks(),layout:HardwareLayout={steppers:[],homing:[{section:'bltouch',mcus:['mcu','aux']}],fans:[],heaters:[]};
const times:number[]=[];for(let batch=0;batch<9;batch++){const start=performance.now();for(let i=0;i<100;i++){const p=compileConfiguredHardware(reader,f.group,clocks,layout);assert.equal(p.configurations[0].plan.oidCount,3);assert.equal(p.configurations[1].plan.oidCount,2);}if(batch>=2)times.push(performance.now()-start);}
times.sort((a,b)=>a-b);assert(times[6]/100<10,'BLTouch cold-start resource compilation exceeds 10ms per plan');console.log(JSON.stringify({node:process.version,iterations:100,warmups:2,samples:7,medianMs:times[3],maxMs:times[6],maxPerPlanMs:times[6]/100,scope:'BLTouch-only two-MCU resource planning; no I/O, no print-path timing, no Python performance comparison.'}));
