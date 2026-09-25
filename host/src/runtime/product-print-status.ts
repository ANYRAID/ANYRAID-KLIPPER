import type {PrintController,PrintState} from '../operations/print.ts';
import type {PrintLayerInfo} from '../gcode/print-layer-info.ts';
const states:Record<PrintState,string>={idle:'standby',interrupted:'error',preparing:'printing',printing:'printing',pausing:'printing',paused:'paused',resuming:'paused',finishing:'printing',completed:'complete',cancelling:'printing',cancelled:'cancelled',failed:'error'};
/** Public compatibility view. Timings, filament and filename require their own
 * accounting/metadata owners; do not synthesize them from file progress. */
export function productPrintStatus(controller:Pick<PrintController,'state'|'currentRequest'>,layers:PrintLayerInfo){
 const state=controller.state,request=controller.currentRequest;
 return {state:states[state],message:state==='interrupted'?'Print interrupted; recovery required':state==='failed'?'Native print failed':'',info:request&&layers.requestId===request.requestId?layers.status:{total_layer:null,current_layer:null}};
}
