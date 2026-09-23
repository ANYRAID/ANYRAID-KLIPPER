import type {NativeLinearHomingPort} from '../homing/native-linear-port.ts';
import type {FilePrintMotion} from './file-print-device.ts';
import {NativePauseParking,type PauseParkingConfig} from './native-pause-parking.ts';
/** Startup/outputs remain machine-owned. Startup must establish readiness and
 * configured homing; output completion must wait for device acknowledgements. */
export interface NativeFileLifecycle {
 prepare:FilePrintMotion['prepare'];start:FilePrintMotion['start'];
 finishOutputs:FilePrintMotion['finish'];stopOutputs:FilePrintMotion['stop'];
 subscribeFault?:FilePrintMotion['subscribeFault'];
}
/** Bind one native motion owner to both file pause paths and final drain.
 * FilePrintDevice owns dispatch cancellation; ThermalPrintDevice owns heaters. */
export function bindNativeFileMotion(port:NativeLinearHomingPort,parking:PauseParkingConfig,lifecycle:NativeFileLifecycle):FilePrintMotion {
 for(const name of ['prepare','start','finishOutputs','stopOutputs'] as const)if(typeof lifecycle[name]!=='function')throw new TypeError('Incomplete native file lifecycle');
 const operation=new NativePauseParking(port,parking),abort=new AbortController();let stopped:Promise<void>|undefined;
 const run=async(signal:AbortSignal,work:(s:AbortSignal)=>Promise<void>)=>{const s=AbortSignal.any([signal,abort.signal]);s.throwIfAborted();port.assertActive();await work(s);s.throwIfAborted();port.assertActive();};
 return {
  prepare:(request,s)=>run(s,signal=>lifecycle.prepare(request,signal)),start:s=>run(s,signal=>lifecycle.start(signal)),
  pause:s=>run(s,signal=>operation.pause(signal)),pauseCheckpoint:s=>run(s,signal=>operation.pause(signal)),resume:s=>run(s,signal=>operation.resume(signal)),
  finish:(id,s)=>run(s,async signal=>{await port.drain(signal);signal.throwIfAborted();await lifecycle.finishOutputs(id,signal);}),
  subscribeFault:lifecycle.subscribeFault?listener=>lifecycle.subscribeFault!(listener):undefined,
  stop(){
   if(stopped)return stopped;const done=Promise.withResolvers<void>();stopped=done.promise;const reason=new Error('Native file motion stopped');abort.abort(reason);
   const jobs:Promise<void>[]=[];for(const stop of [()=>port.motorOff(reason),()=>lifecycle.stopOutputs()])try{jobs.push(stop());}catch(error){jobs.push(Promise.reject(error));}
   void Promise.allSettled(jobs).then(results=>{const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length)done.reject(new AggregateError(errors,'Native motion and output stop failed'));else done.resolve();});return stopped;
  },
 };
}
