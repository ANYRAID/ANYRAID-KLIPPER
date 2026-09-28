import assert from 'node:assert/strict';
import {startConfiguredHardware} from '../src/runtime/configured-hardware.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {hardwareStartupFixture} from '../test/helpers/hardware-startup.ts';
import {hardwareReader,hardwareLayout} from '../test/helpers/configured-hardware.ts';
const reader=new ConfigurationReader(new ConfigurationSource('/outputs.cfg',{
 ...hardwareReader().source.original,
 'output_pin light':{pin:'!PA4',value:'1'},
 'output_pin duty':{pin:'aux:PA4',pwm:'true',hardware_pwm:'true',value:'.5'},
 'output_pin soft':{pin:'aux:PA5',pwm:'true',value:'.4'},
},[]),null);
const samples:{baseMs:number;outputsMs:number}[]=[];
for(let run=0;run<10;run++){
 const result={baseMs:0,outputsMs:0};
 for(const extra of run%2?[true,false]:[false,true]){
  const f=await hardwareStartupFixture(false,false,true);
  try{
   const start=performance.now();
   const h=await startConfiguredHardware(reader,f.group,f.clocks,{...hardwareLayout,
    outputPins:extra?['light','duty','soft'].map(name=>({section:`output_pin ${name}`})):[],
   },{beforeTarget(){}},f.signal);
   result[extra?'outputsMs':'baseMs']=performance.now()-start;
   assert.equal(h.outputPins.length,extra?3:0);assert.equal(h.status.state,'ready');
   await h.close();assert.deepEqual(f.stops,[1,1]);
  }finally{await f.close();}
 }
 if(run>=3)samples.push(result);
}
console.log(JSON.stringify({node:process.version,warmups:3,samples,
 medianBaseMs:samples.map(s=>s.baseMs).sort((a,b)=>a-b)[3],
 medianOutputsMs:samples.map(s=>s.outputsMs).sort((a,b)=>a-b)[3],
 scope:'Cold hardware startup after connection, two native serial queues with simulated MCU, base stepper/heater/fan versus three added output pins; not print throughput or real hardware'},null,2));
