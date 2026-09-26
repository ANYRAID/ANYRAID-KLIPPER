import type {PrintController,PrintState} from '../operations/print.ts';
import type {PrintLayerInfo} from '../gcode/print-layer-info.ts';
const states:Record<PrintState,string>={idle:'standby',interrupted:'error',preparing:'printing',printing:'printing',pausing:'printing',paused:'paused',resuming:'paused',finishing:'printing',completed:'complete',cancelling:'printing',cancelled:'cancelled',failed:'error'};
/** Public compatibility view. Durations and commanded filament come from their
 * lifecycle owners; never synthesize them from file progress. */
export function productPrintStatus(controller:Pick<PrintController,'state'|'currentRequest'>&Partial<Pick<PrintController,'totalDuration'|'filamentUsed'|'printDuration'>>,layers:PrintLayerInfo,filename?:(fileId:string)=>string){
 const state=controller.state,request=controller.currentRequest;
 // Read the subset duration first so a later monotonic read of the total cannot
 // accidentally be smaller solely because of time spent building this snapshot.
 const printDuration=controller.printDuration;
 return {...filename?{filename:request?filename(request.fileId):''}:{},...('printDuration' in controller?{print_duration:printDuration}:{}),...('totalDuration' in controller?{total_duration:controller.totalDuration}:{}),...('filamentUsed' in controller?{filament_used:controller.filamentUsed}:{}),state:states[state],message:state==='interrupted'?'Print interrupted; recovery required':state==='failed'?'Native print failed':'',info:request&&layers.requestId===request.requestId?layers.status:{total_layer:null,current_layer:null}};
}

/** Paused becomes true only after pause acknowledgment; a pending resume has
 * not yet released the retained file/motion boundary. */
export function productPauseStatus(state:PrintState){return {is_paused:state==='paused'||state==='resuming'};}
