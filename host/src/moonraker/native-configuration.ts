import {randomUUID} from 'node:crypto';
import {ApiError,type Json} from './rpc.ts';
import type {EndpointRegistry} from './endpoints.ts';
import {KlipperSaveSession} from '../config/klipper-save-session.ts';
import {bedMeshProfileChanges} from '../motion/bed-mesh-save.ts';
import {BedMeshProfiles} from '../motion/bed-mesh-profiles.ts';
import type {BedMesh} from '../motion/bed-mesh.ts';
import {MaintenanceGate} from '../operations/maintenance-gate.ts';
/** Maintenance is separate from print-file G-code. A successful write fences
 * printing until explicit host reinitialization reloads the saved configuration. */
export function registerNativeConfiguration(registry:EndpointRegistry,session:KlipperSaveSession,gate:MaintenanceGate,profiles:BedMeshProfiles,motion:{current():BedMesh|null;idle():boolean}){
 const token=randomUUID();let state:'ready'|'saving'|'saved'|'failed'='ready',profile:string|null=null,action:'save'|'remove'='save',closed=false,pending:Promise<Json>|undefined;
 const lifetime=new AbortController();
 const snapshot=()=>({state_token:token,state,profile,action,restart_required:state==='saved'||state==='failed',available:!closed&&state==='ready'&&!gate.status.closed});
 const releases=[registry.register({endpoint:'/printer/configuration',methods:['GET']},async()=>snapshot())];
 releases.push(registry.register({endpoint:'/printer/configuration/bed_mesh',methods:['POST']},async(params,_verb,context)=>{
  if(Object.keys(params).some(k=>!['version','state_token','profile','action'].includes(k))||params.version!==1||typeof params.profile!=='string'||typeof params.state_token!=='string')throw new ApiError(400,'Expected version, state_token and profile');
  const requestedAction=params.action??'save';if(requestedAction!=='save'&&requestedAction!=='remove')throw new ApiError(400,'Invalid configuration action');
  if(params.state_token!==token)throw new ApiError(409,'Stale configuration state token');
  if(closed)throw new ApiError(503,'Configuration owner closed');
  if(state==='saved'&&params.profile===profile&&requestedAction===action)return snapshot();
  if(state!=='ready')throw new ApiError(409,'Configuration requires reinitialization or an operation is pending');
  if(!motion.idle())throw new ApiError(409,'Configuration save requires an idle printer');
  let release:()=>void;try{release=gate.acquire();}catch{throw new ApiError(409,'Printer activity blocks configuration save');}
  // Reject active printers before copying grids or serializing calibration.
  let changes:ReturnType<typeof bedMeshProfileChanges>;
  try{
   if(requestedAction==='remove'){
    if(!session.hasSavedSection('bed_mesh '+params.profile))throw new ApiError(404,'Profile is not in the automatic save area');
    changes=[{kind:'remove',section:'bed_mesh '+params.profile}];
   }else{
   const mesh=motion.current();if(!mesh)throw new ApiError(409,'No active bed mesh to save');
   try{changes=bedMeshProfileChanges(params.profile,mesh,'roundtrip');}catch{throw new ApiError(400,'Invalid bed mesh profile');}
   const names=profiles.names;if(!names.includes(params.profile)&&names.length+profiles.incompatible.length>=128)throw new ApiError(413,'Mesh profile capacity exceeded');
   let cells=mesh.width*mesh.height;for(const name of names)if(name!==params.profile){const saved=profiles.load(name);cells+=saved.width*saved.height;}if(cells>2000000)throw new ApiError(413,'Mesh grid capacity exceeded');
   if(params.profile==='default')throw new ApiError(400,'Profile default is reserved');
   }
  }catch(error){release();throw error;}
  const signal=AbortSignal.any([context.signal,lifetime.signal]);state='saving';profile=params.profile;action=requestedAction;
  pending=(async()=>{try{
   signal.throwIfAborted();session.apply(changes);const result=await session.save(signal,action==='remove'?{allowEmpty:true,absentSections:['bed_mesh '+profile]}:{});
   if(!result||result.pending)throw new Error('Configuration save did not settle');
   session.sealForRestart();state='saved';return snapshot();
  }catch(error){state='failed';throw new ApiError(503,'Configuration save failed; reinitialize and inspect configuration before retrying');}
  finally{gate.invalidate();release();}})();
  try{return await pending;}finally{pending=undefined;}
 }));
 return async()=>{closed=true;lifetime.abort(new Error('Configuration owner closed'));for(const release of releases)release();await pending?.catch(()=>{});};
}
