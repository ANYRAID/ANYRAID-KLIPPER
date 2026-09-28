import {configuredPrinterFixture} from '../test/helpers/configured-printer.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {planLinearPrinter} from '../src/config/linear-printer.ts';
const f=await configuredPrinterFixture(),single:number[]=[],dual:number[]=[];
try{
 const original=f.reader.source.original,reader=new ConfigurationReader(new ConfigurationSource('/multi.cfg',{...original,extruder1:{...original.extruder,step_pin:'aux:PA6',dir_pin:'aux:PA7',enable_pin:'!aux:PA8',heater_pin:'aux:PA9',sensor_pin:'aux:PA10',max_extrude_only_velocity:'5'}},[]),null),policy={mcus:['mcu','aux'],enableLeadTime:.001,fanMinimumScheduleTime:.001};
 for(let round=0;round<8;round++)for(const multiple of round%2?[true,false]:[false,true]){const start=performance.now();for(let i=0;i<1000;i++)planLinearPrinter(multiple?reader:f.reader,policy);if(round>=3)(multiple?dual:single).push((performance.now()-start)/1000);}
 console.log(JSON.stringify({runtime:process.version,scope:'1000 configuration plans per sample, alternating order, three warmup rounds, five retained; fixture IO excluded; no per-step or physical latency claim',single:{samplesMs:single,medianMs:[...single].sort((a,b)=>a-b)[2]},dual:{samplesMs:dual,medianMs:[...dual].sort((a,b)=>a-b)[2]}},null,2));
}finally{await f.close();}
