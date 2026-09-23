import {planLinearPrinter} from '../../src/config/linear-printer.ts';
import {initialMotionSetup} from './initial-motion.ts';
import type {ConfiguredPrinterOptions} from '../../src/runtime/configured-printer.ts';
export async function configuredPrinterFixture(reverse=false,autostart=true){
 const f=await initialMotionSetup(reverse,true,true,autostart);
 const plan=planLinearPrinter(f.reader,{mcus:f.connections.map(c=>c.id),enableLeadTime:.001,fanMinimumScheduleTime:.001});
 const options:ConfiguredPrinterOptions={hardware:{...f.hardwareOptions,motion:plan.motion},motion:plan.initial,linear:plan.linear,print:{output(){},motorCompletion:'hold',startupHoming:{mode:'home',axes:[0,1,2]},parking:{parkXY:[0,0],retract:0,lift:0,travelSpeed:10,liftSpeed:5,retractSpeed:5},lifecycle:{prepare:async()=>{},start:async()=>{},finishOutputs:async()=>{},stopOutputs:async()=>{}},open:async()=>{throw new Error('Unexpected file open');}}};
 return {...f,layout:plan.layout,options};
}
