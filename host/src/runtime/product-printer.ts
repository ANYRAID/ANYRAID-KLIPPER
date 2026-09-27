import {connectConfiguredPrinter,type ConfiguredPrinterOptions} from './configured-printer.ts';
import {PrintController,type PrintLimits,type PrintDeadlines} from '../operations/print.ts';
import {PrintJournal} from '../operations/print-journal.ts';
import {MaintenanceGate} from '../operations/maintenance-gate.ts';
import type {KlipperSaveSession} from '../config/klipper-save-session.ts';
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import type {MCUConnection} from './mcu-group.ts';
import type {HardwareLayout} from '../config/hardware.ts';
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
 const printer=await connectConfiguredPrinter(reader,connections,primaryId,layout,options,signal);
 let controller:PrintController|undefined,closing:Promise<void>|undefined;
 const aborted=()=>{void printer.close(signal.reason).catch(()=>{});};signal.addEventListener('abort',aborted,{once:true});
 try{
  signal.throwIfAborted();
  controller=await PrintController.restore(printer.print.device,limits,deadlines,{journal,maintenanceGate,maxRememberedRequests,extrusionAccounting:printer.print.gcode.coordinates.extrusionAccounting});
  signal.throwIfAborted();printer.group.assertActive();
  const owned=controller;
  const close=():Promise<void>=>{
   if(closing)return closing;const done=Promise.withResolvers<void>();closing=done.promise;maintenanceGate.invalidate();
   const jobs=[owned.retire(),printer.close()];
   void Promise.allSettled(jobs).then(results=>{const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length)done.reject(new AggregateError(errors,'Product printer cleanup failed'));else done.resolve();});return closing;
  };
  return Object.freeze({...printer,controller:owned,maintenanceGate,close});
 }catch(error){maintenanceGate.invalidate();try{await printer.close(error);}catch(cleanup){throw new AggregateError([error,cleanup],'Product printer startup and cleanup failed',{cause:error});}throw error;}
 finally{signal.removeEventListener('abort',aborted);}
}
