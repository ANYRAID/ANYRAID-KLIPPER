import {randomUUID} from 'node:crypto';
import {ApiError,type Json} from './rpc.ts';
import type {EndpointRegistry} from './endpoints.ts';
import type {MaintenanceGate} from '../operations/maintenance-gate.ts';
import type {GCodeFileReader,GCodeFileIdentity} from '../gcode/file-reader.ts';
import {readFileObjectFootprint} from '../gcode/file-object-footprint.ts';
import {adaptProbeGrid} from '../homing/adaptive-probe-grid.ts';
import {planProbeGrid,type ProbeGrid} from '../homing/probe-grid.ts';
import type {BedMesh} from '../motion/bed-mesh.ts';
export function registerNativeAdaptiveMesh(registry:EndpointRegistry,gate:MaintenanceGate,grid:ProbeGrid,port:{idle():boolean;open(fileId:string,signal:AbortSignal):Promise<GCodeFileReader>;measure(grid:ProbeGrid,signal:AbortSignal):Promise<BedMesh>;activate(mesh:BedMesh,identity:Readonly<GCodeFileIdentity>|undefined,signal:AbortSignal):Promise<void>;fail(cause:unknown):Promise<void>}){
 let token=randomUUID(),closed=false,failed=false,pending:Promise<Json>|undefined,receipt:{token:string;key:string;value:Json}|undefined;
 const lifetime=new AbortController(),snapshot=()=>({state_token:token,available:!closed&&!failed&&!pending&&gate.available&&port.idle()});
 const unregister=registry.register({endpoint:'/printer/calibration/bed_mesh/adaptive',methods:['GET','POST']},async(params,verb,context)=>{
  if(verb==='GET')return snapshot();
  if(Object.keys(params).some(k=>!['version','state_token','file_id','margin'].includes(k))||params.version!==1||typeof params.state_token!=='string'||typeof params.file_id!=='string'||!params.file_id||params.file_id.length>4096||/[\x00-\x1f\x7f]/.test(params.file_id)||params.margin!==undefined&&(typeof params.margin!=='number'||!Number.isFinite(params.margin)||params.margin<0))throw new ApiError(400,'Expected version, state_token, file_id and optional nonnegative margin');
  if(closed||failed||gate.status.closed)throw new ApiError(503,'Adaptive calibration unavailable');const key=JSON.stringify([params.file_id,params.margin??0]);
  if(receipt?.token===params.state_token){if(receipt.key!==key)throw new ApiError(409,'Adaptive calibration retry conflicts');return structuredClone(receipt.value);}
  if(params.state_token!==token)throw new ApiError(409,'Stale adaptive calibration token');if(!snapshot().available)throw new ApiError(409,'Adaptive calibration requires idle homed printer');
  let release:()=>void;try{release=gate.acquire();}catch{throw new ApiError(409,'Printer activity blocks adaptive calibration');}
  const consumed=token,deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(Error('Adaptive calibration deadline')),120000),signal=AbortSignal.any([context.signal,lifetime.signal,deadline.signal]);
  pending=(async()=>{let reader:GCodeFileReader|undefined,moving=false;try{
   reader=await port.open(params.file_id as string,signal);const footprint=await readFileObjectFootprint(reader,signal),adapted=adaptProbeGrid(grid,footprint.polygons,params.margin as number|undefined),plan=planProbeGrid(adapted.grid,[0,0,0]);
   await reader.assertUnchanged(signal);moving=true;const mesh=await port.measure(adapted.grid,signal);await reader.assertUnchanged(signal);await port.activate(mesh,adapted.adapted?footprint.identity:undefined,signal);signal.throwIfAborted();
   token=randomUUID();const value={...snapshot(),available:false,file_id:params.file_id as string,digest:footprint.digest,digest_format:footprint.digestFormat,adapted:adapted.adapted,contact_count:plan.points.length,probe_count:[mesh.params.x_count,mesh.params.y_count],range:mesh.range(),persisted:false};receipt={token:consumed,key,value:structuredClone(value)};return value;
  }catch(error){token=randomUUID();if(moving){failed=true;gate.invalidate();await port.fail(error).catch(()=>{});throw new ApiError(503,'Adaptive calibration failed; reinitialize printer');}throw new ApiError(400,'Selected file cannot provide a valid adaptive calibration source');}
   finally{clearTimeout(timer);try{await reader?.close();}catch(error){receipt=undefined;failed=true;gate.invalidate();await port.fail(error).catch(()=>{});throw new ApiError(503,'Adaptive source cleanup failed; reinitialize printer');}finally{release();}}})();
  try{return await pending;}finally{pending=undefined;}
 });
 return async()=>{closed=true;unregister();lifetime.abort(Error('Adaptive calibration closed'));await pending?.catch(()=>{});};
}
