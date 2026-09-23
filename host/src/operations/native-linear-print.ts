import {NativeLinearGCode} from '../runtime/native-linear-gcode.ts';
import {NativeLinearHomingPort} from '../homing/native-linear-port.ts';
import {AsyncPrinterHeaters} from '../thermal/async-heaters.ts';
import {bindNativeFileMotion,type NativeFileLifecycle} from './native-file-motion.ts';
import type {PauseParkingConfig} from './native-pause-parking.ts';
import {FilePrintDevice} from './file-print-device.ts';
import {ThermalPrintDevice} from './thermal-print-device.ts';
const owners=new WeakSet<NativeLinearGCode>();
export interface NativeLinearPrintOptions {
 gcode:NativeLinearGCode;port:NativeLinearHomingPort;heaters:AsyncPrinterHeaters;
 mapping:{nozzle:string;bed:string};parking:PauseParkingConfig;lifecycle:NativeFileLifecycle;
 open:ConstructorParameters<typeof FilePrintDevice>[2];
}
/** Transfers these dedicated owners after validation. Machine configuration,
 * the live extrusion-temperature guard and authorized sealed files must already
 * be wired. Failed assembly closes the transferred motion/heater/output owners. */
export async function createNativeLinearPrint(o:NativeLinearPrintOptions){
 const {gcode,port,heaters,lifecycle}=o;
 if(!(gcode instanceof NativeLinearGCode)||!(port instanceof NativeLinearHomingPort)||!(heaters instanceof AsyncPrinterHeaters)||!gcode.usesPort(port)||owners.has(gcode)||typeof o.open!=='function')throw new Error('Invalid native print ownership');
 const names=heaters.status.available_heaters.map(name=>name.trim().split(/\s+/).at(-1));
 if(!heaters.status.started||heaters.status.closed||!names.includes(o.mapping.nozzle)||!names.includes(o.mapping.bed)||o.mapping.nozzle===o.mapping.bed)throw new Error('Native print heaters are not ready or mapped');
 for(const key of ['prepare','start','finishOutputs','stopOutputs'] as const)if(typeof lifecycle[key]!=='function')throw new Error('Incomplete native print lifecycle');
 port.assertActive();owners.add(gcode);
 let device:ThermalPrintDevice|undefined,closing:Promise<void>|undefined;
 const close=():Promise<void>=>{
  if(closing)return closing;const done=Promise.withResolvers<void>();closing=done.promise;
  const jobs:Promise<void>[]=[];
  for(const stop of [()=>device?device.stop():lifecycle.stopOutputs(),()=>gcode.close()])try{jobs.push(stop());}catch(error){jobs.push(Promise.reject(error));}
  // If binding failed there is no thermal wrapper to initiate heater reset.
  if(!device)jobs.push(heaters.shutdown('Native print assembly failed'));
  void Promise.allSettled(jobs).then(async results=>{
   const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);
   try{await heaters.shutdown('Native print closed');}catch(error){errors.push(error);}
   if(errors.length)done.reject(new AggregateError(errors,'Native print cleanup failed'));else done.resolve();
  });return closing;
 };
 try{
  const motion=bindNativeFileMotion(port,o.parking,{...lifecycle,prepare:async(request,signal)=>{await lifecycle.prepare(request,signal);signal.throwIfAborted();gcode.enable();}});
  const file=new FilePrintDevice(motion,gcode.dispatch,o.open);device=new ThermalPrintDevice(file,heaters,{...o.mapping});
  heaters.attach(gcode.dispatch,{bed:o.mapping.bed,extruders:[o.mapping.nozzle]});
  return {device,file,gcode,close};
 }catch(error){try{await close();}catch(cleanupError){throw new AggregateError([error,cleanupError],'Native print assembly and cleanup failed');}throw error;}
}
