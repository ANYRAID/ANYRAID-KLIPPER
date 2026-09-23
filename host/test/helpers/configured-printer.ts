import {initialMotionOptions,initialMotionSetup} from './initial-motion.ts';
import type {ConfiguredPrinterOptions} from '../../src/runtime/configured-printer.ts';
export async function configuredPrinterFixture(reverse=false){
 const f=await initialMotionSetup(reverse,true,true);
 const options:ConfiguredPrinterOptions={hardware:f.hardwareOptions,motion:{...structuredClone(initialMotionOptions),fanSection:'fan'},linear:{kinematicIds:['x','y','z'],homing:['x','y','z'].map(axis=>[{section:`stepper_${axis}`,emitters:['x','y','z','e']}]) as unknown as ConfiguredPrinterOptions['linear']['homing']},print:{output(){},motorCompletion:'hold',startupHoming:{mode:'home',axes:[0,1,2]},parking:{parkXY:[0,0],retract:0,lift:0,travelSpeed:10,liftSpeed:5,retractSpeed:5},lifecycle:{prepare:async()=>{},start:async()=>{},finishOutputs:async()=>{},stopOutputs:async()=>{}},open:async()=>{throw new Error('Unexpected file open');}}};
 return {...f,options};
}
