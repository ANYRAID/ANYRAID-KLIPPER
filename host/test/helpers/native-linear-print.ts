import type {RetractionSettings} from '../../src/gcode/retraction.ts';
import {mkdtemp,writeFile,open,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {nativeLinearFixture} from './native-linear-port.ts';
import {NativeLinearGCode} from '../../src/runtime/native-linear-gcode.ts';
import {AsyncPrinterHeaters} from '../../src/thermal/async-heaters.ts';
import {AsyncHeaterRuntime} from '../../src/thermal/async-runtime.ts';
import {BangBangControl} from '../../src/thermal/control.ts';
import {GCodeFileReader} from '../../src/gcode/file-reader.ts';
import type {NativeLinearPrintOptions} from '../../src/operations/native-linear-print.ts';
export async function nativePrintFixture(script='M105\nG1 X51 E2.01 F600\n',holdOff=false,motorPower:boolean|'always'|'mixed'=false,synchronized=false,arcResolution=1,retraction?:RetractionSettings,excludeObjects=false){
 const t=await nativeLinearFixture(0,()=>true,false,undefined,motorPower,synchronized,synchronized),dir=await mkdtemp(join(tmpdir(),'native-print-')),path=join(dir,'job.gcode'),reports:string[]=[],resetCounts=[0,0],off=Promise.withResolvers<void>(),runtimes:AsyncHeaterRuntime[]=[];
 const gcode=new NativeLinearGCode(t.port,t.kinematics,[51,0,0].map(endstop=>({endstop,positiveDirection:false,speed:10,retractDistance:0,retractSpeed:10,secondSpeed:5,endstops:['test']})),m=>reports.push(m),undefined,arcResolution,retraction,undefined,undefined,excludeObjects);
 const heaters=new AsyncPrinterHeaters(s=>t.port.drain(s));let outputStops=0,outputFinishes=0;
 for(const [i,name] of ['extruder','bed'].entries()){
  const runtime=new AsyncHeaterRuntime({minimum:0,maximum:300,minimumExtrude:170,smoothTime:1,maxPower:1,reportDelay:.3},new BangBangControl(1),{configuration:{cycleTime:.1,maximumDuration:3,initialPower:0,defaultPower:0},async reset(){resetCounts[i]++;if(holdOff&&resetCounts[i]>1)await off.promise;},setPWM:async()=>{},stop:async()=>{}},()=>({system:1,print:1}),{},()=>()=>{});
  heaters.register(name,runtime,i?'B':'T');runtimes.push(runtime);
 }
 try{await heaters.start();runtimes[0].sample(1,220);runtimes[1].sample(1,80);await writeFile(path,script);}
 catch(error){await gcode.close();await heaters.shutdown();await t.close();await rm(dir,{recursive:true,force:true});throw error;}
 const options:NativeLinearPrintOptions={gcode,port:t.port,heaters,motorCompletion:'hold',startupHoming:{mode:'require_homed',axes:[0,1,2]},mapping:{nozzle:'extruder',bed:'bed'},parking:{parkXY:[50,0],retract:0,lift:0,travelSpeed:10,liftSpeed:5,retractSpeed:5},lifecycle:{prepare:async()=>{t.kinematics.markHomed([0,1,2]);},start:async()=>{},finishOutputs:async()=>{outputFinishes++;},stopOutputs:async()=>{outputStops++;}},open:async()=>GCodeFileReader.adopt(await open(path,'r'))};
 return {t,gcode,heaters,runtimes,reports,resetCounts,off,options,get outputStops(){return outputStops;},get outputFinishes(){return outputFinishes;},async close(){off.resolve();await gcode.close();await heaters.shutdown();await t.close();await rm(dir,{recursive:true,force:true});}};
}
