import {GCodeDispatch,GCodeError} from '../gcode/dispatch.ts';
import {BedMesh} from './bed-mesh.ts';
import {BedMeshProfileStore} from './bed-mesh-profile-store.ts';
export interface BedMeshProfileRuntime {
 current():BedMesh|null;
 /** Runtime must drain motion and atomically install this owned mesh, honoring
  * cancellation before publication. Resolving means the transition completed. */
 activate(mesh:BedMesh,name:string,signal:AbortSignal):void|Promise<void>;
}
export function registerBedMeshProfile(dispatch:GCodeDispatch,store:BedMeshProfileStore,runtime:BedMeshProfileRuntime):void{
 dispatch.register('BED_MESH_PROFILE',async command=>{
  try{
   const action=(['LOAD','SAVE','REMOVE'] as const).find(key=>Object.hasOwn(command.params,key));
   if(!action){command.respondInfo(`Invalid syntax '${command.commandline}'`);return;}
   const name=command.params[action];if(!name.trim())throw new GCodeError(`Value for parameter '${action}' must be specified`);
   if(action==='LOAD'){
    const mesh=store.load(name);command.signal.throwIfAborted();
    try{await runtime.activate(mesh,name,command.signal);command.signal.throwIfAborted();}
    catch(error){if(!command.signal.aborted)dispatch.setReady(false,'Bed mesh activation failed');throw error;}
   }else if(action==='SAVE'){
    if(name==='default'){command.respondInfo("Profile 'default' is reserved, please choose another profile name.");return;}
    const mesh=runtime.current();if(!mesh){command.respondInfo(`Unable to save to profile [${name}], the bed has not been probed`);return;}
    store.save(name,mesh);command.respondInfo(`Bed Mesh state has been saved to profile [${name}]\nfor the current session.  The SAVE_CONFIG command will\nupdate the printer config file and restart the printer.`);
   }else{command.respondInfo(store.remove(name)?`Profile [${name}] removed from storage for this session.\nThe SAVE_CONFIG command will update the printer\nconfiguration and restart the printer`:`No profile named [${name}] to remove`);}
  }catch(error){if(error instanceof GCodeError)throw error;throw new GCodeError('BED_MESH_PROFILE failed: '+(error instanceof Error?error.message:String(error)),{cause:error});}
 });
}
