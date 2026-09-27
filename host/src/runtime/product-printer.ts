import {FilamentEncoder,readFilamentEncoderPolicy} from '../inputs/filament-encoder.ts';
import {connectConfiguredPrinter,type ConfiguredPrinterOptions} from './configured-printer.ts';
import {PrintController,type PrintLimits,type PrintDeadlines} from '../operations/print.ts';
import {PrintJournal} from '../operations/print-journal.ts';
import {MaintenanceGate} from '../operations/maintenance-gate.ts';
import type {KlipperSaveSession} from '../config/klipper-save-session.ts';
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import type {MCUConnection} from './mcu-group.ts';
import type {HardwareLayout} from '../config/hardware.ts';
import {FilamentSwitch,readFilamentPolicy} from '../inputs/filament-switch.ts';
import {registerConfiguredCleanup} from './configured-hardware.ts';
import {serialClock} from '../protocol/serial-queue.ts';
export interface ProductPrinterOptions {
 configurationSession?:KlipperSaveSession;
 limits:PrintLimits;deadlines?:Partial<PrintDeadlines>;maxRememberedRequests?:number;
 /** External owners: share gate with Moonraker and retain journal until shutdown
  * and all pending controller actions settle, including failed shutdown. */
 journal:PrintJournal;maintenanceGate:MaintenanceGate;
}
/** Connect actual hardware and restore durable metadata without replaying a job.
 * Returned controller/gate can be passed to ConfiguredMoonraker native mode. */
export async function connectProductPrinter(reader:ConfigurationReader,connections:readonly MCUConnection[],primaryId:string,layout:HardwareLayout,options:ConfiguredPrinterOptions,product:ProductPrinterOptions,signal:AbortSignal){
 signal.throwIfAborted();
 if(!(product.journal instanceof PrintJournal)||!(product.maintenanceGate instanceof MaintenanceGate)||product.maintenanceGate.status.closed)throw new Error('Product printer requires an open gate and journal');
 const {journal,maintenanceGate,maxRememberedRequests}=product,limits={...product.limits},deadlines={...product.deadlines};
 const filamentPolicies=new Map((layout.buttons??[]).filter(b=>/^filament_(switch|motion)_sensor /.test(b.section)).map(b=>[b.section,b.section.startsWith('filament_motion_sensor ')?readFilamentEncoderPolicy(reader,b.section):readFilamentPolicy(reader,b.section)]));
 const printer=await connectConfiguredPrinter(reader,connections,primaryId,layout,options,signal);
 let controller:PrintController|undefined,closing:Promise<void>|undefined;
 const sensors:{section:string;runtime:FilamentSwitch|FilamentEncoder}[]=[];
 const requireFilament=()=>{for(const sensor of sensors)if(!sensor.runtime.canResume)throw new Error('Filament is absent or unconfirmed in '+sensor.section);};
 const aborted=()=>{void printer.close(signal.reason).catch(()=>{});};signal.addEventListener('abort',aborted,{once:true});
 try{
  signal.throwIfAborted();
  controller=await PrintController.restore(printer.print.device,limits,deadlines,{journal,maintenanceGate,maxRememberedRequests,extrusionAccounting:printer.print.gcode.coordinates.extrusionAccounting,beforeStart:requireFilament,beforeResume:requireFilament});
  signal.throwIfAborted();printer.group.assertActive();
  const owned=controller;
  const sensorAbort=new AbortController();
  registerConfiguredCleanup(printer.hardware,async()=>{sensorAbort.abort();for(const sensor of sensors)sensor.runtime.close();});
  for(const button of printer.hardware.buttons){const policy=filamentPolicies.get(button.section);if(policy){const printing=()=>owned.state==='printing',pause=()=>owned.pause(),fault=(error:unknown)=>{void printer.close(error).catch(()=>{});};sensors.push({section:button.section,runtime:'detectionLength' in policy?new FilamentEncoder(button.input,readFilamentEncoderPolicy(reader,button.section),serialClock,time=>printer.linear.port.observedActuatorPosition('e',time),printing,pause,fault):new FilamentSwitch(button.input,policy,serialClock,printing,pause,fault)});}}
  const changes=owned.watchState(sensorAbort.signal);
  void (async()=>{try{for await(const change of changes){if(change.state==='printing')for(const sensor of sensors)sensor.runtime.stateChanged();}}catch(error){if(!sensorAbort.signal.aborted)void printer.close(error).catch(()=>{});}})();
  const close=():Promise<void>=>{
   if(closing)return closing;const done=Promise.withResolvers<void>();closing=done.promise;maintenanceGate.invalidate();
   const jobs=[owned.retire(),printer.close()];
   void Promise.allSettled(jobs).then(results=>{const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length)done.reject(new AggregateError(errors,'Product printer cleanup failed'));else done.resolve();});return closing;
  };
  return Object.freeze({...printer,controller:owned,maintenanceGate,filamentSensors:Object.freeze(sensors),close});
 }catch(error){maintenanceGate.invalidate();try{await printer.close(error);}catch(cleanup){throw new AggregateError([error,cleanup],'Product printer startup and cleanup failed',{cause:error});}throw error;}
 finally{signal.removeEventListener('abort',aborted);}
}
