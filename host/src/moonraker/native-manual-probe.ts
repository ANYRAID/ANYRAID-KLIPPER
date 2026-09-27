import type {EndpointRegistry} from './endpoints.ts';
import type {MaintenanceGate} from '../operations/maintenance-gate.ts';
import {registerManualBedTilt,type ManualBedTiltMotion} from './native-manual-bed-tilt.ts';
/** One contact measurement at the current XY. No arbitrary scripts, automatic
 * XY travel or persistent configuration mutation. Shares the interactive lease,
 * motor-resolved Z search, retry receipts and fault cleanup with bed tilt. */
export function registerManualProbe(registry:EndpointRegistry,gate:MaintenanceGate,motion:Omit<ManualBedTiltMotion,'apply'>,idleTimeoutMs=300000){
 return registerManualBedTilt(registry,gate,{...motion,apply:async(samples,signal)=>{signal.throwIfAborted();return {position:[...samples[0]],persisted:false};}},{points:[[0,0]],horizontalHeight:0,travelSpeed:5},idleTimeoutMs,'probe');
}
