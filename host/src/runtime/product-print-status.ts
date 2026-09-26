import type {PrintController,PrintState} from '../operations/print.ts';
import type {PrintLayerInfo} from '../gcode/print-layer-info.ts';
const states:Record<PrintState,string>={idle:'standby',interrupted:'error',preparing:'printing',printing:'printing',pausing:'printing',paused:'paused',resuming:'paused',finishing:'printing',completed:'complete',cancelling:'printing',cancelled:'cancelled',failed:'error'};
/** Public compatibility view. Timings and filament require their own
 * accounting/metadata owners; do not synthesize them from file progress. */
export function productPrintStatus(controller:Pick<PrintController,'state'|'currentRequest'>,layers:PrintLayerInfo,filename?:(fileId:string)=>string){
 const state=controller.state,request=controller.currentRequest;
 return {...filename?{filename:request?filename(request.fileId):''}:{},state:states[state],message:state==='interrupted'?'Print interrupted; recovery required':state==='failed'?'Native print failed':'',info:request&&layers.requestId===request.requestId?layers.status:{total_layer:null,current_layer:null}};
}

/** Paused becomes true only after pause acknowledgment; a pending resume has
 * not yet released the retained file/motion boundary. */
export function productPauseStatus(state:PrintState){return {is_paused:state==='paused'||state==='resuming'};}
