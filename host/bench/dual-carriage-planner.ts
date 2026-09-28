import assert from 'node:assert/strict';
import {configuredPrinterFixture} from '../test/helpers/configured-printer.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {planLinearPrinter} from '../src/config/linear-printer.ts';
const f=await configuredPrinterFixture(false,false),policy={mcus:['mcu','aux'],enableLeadTime:.001,fanMinimumScheduleTime:.001},results:Record<string,number[]>={single:[],dual:[]};
const reader=new ConfigurationReader(new ConfigurationSource('/idex.cfg',{...f.reader.source.original,dual_carriage:{axis:'x',position_min:'10',position_max:'220',position_endstop:'220',step_pin:'aux:PA6',dir_pin:'aux:PA7',endstop_pin:'aux:PA8',rotation_distance:'40',microsteps:'16'}},[]),null);
try{
 for(let round=0;round<8;round++)for(const kind of round%2?['single','dual']:['dual','single']){
  const start=performance.now();for(let i=0;i<1000;i++){const plan=planLinearPrinter(kind==='single'?f.reader:reader,policy);assert.equal(plan.motion.length,kind==='single'?4:5);}
  if(round>=3)results[kind].push((performance.now()-start)/1000);
 }
 console.log(JSON.stringify({runtime:process.version,scope:'1000 configuration-to-hardware plans per sample, alternating single/dual; excludes native allocation and MCU IO',results:Object.fromEntries(Object.entries(results).map(([name,samplesMs])=>[name,{samplesMs,medianMs:[...samplesMs].sort((a,b)=>a-b)[2]}]))},null,2));
}finally{await f.close();}
