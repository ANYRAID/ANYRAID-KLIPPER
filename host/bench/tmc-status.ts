import assert from 'node:assert/strict';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {planTmc220x} from '../src/drivers/tmc220x.ts';
import {tmc220xStatusReader} from '../src/drivers/tmc220x-status.ts';
import {NativeObjects} from '../src/moonraker/native-objects.ts';
const reader=new ConfigurationReader(new ConfigurationSource('/tmc.cfg',{'tmc2209 stepper_x':{run_current:'.8'},stepper_x:{microsteps:'16',rotation_distance:'40'}},[]),null),plan=planTmc220x(reader,'tmc2209 stepper_x');
const state={closed:false,checks:1,drvStatus:0x801f0000,gstat:0,warnings:0,fault:undefined},names=['x','y','z','e'].map(n=>'tmc2209 '+n),catalog=new NativeObjects(new Map(names.map(n=>[n,tmc220xStatusReader(plan,{status:state})])),()=>1),query=Object.fromEntries(names.map(n=>[n,null])),samples:number[]=[];
for(let batch=0;batch<9;batch++){const start=performance.now();for(let i=0;i<2000;i++){const result=catalog.query(query);assert.equal(Object.keys(result.status).length,4);}if(batch>=2)samples.push(performance.now()-start);}
samples.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,queries:2000,driversPerQuery:4,warmups:2,batches:7,medianMs:samples[3],p95Ms:samples[6],perQueryMedianMs:samples[3]/2000,scope:'Cached field decoding, NativeObjects validation/projection/detached copies; no UART, HTTP or physical driver'}));
