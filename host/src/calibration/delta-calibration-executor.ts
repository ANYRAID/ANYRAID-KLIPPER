import {Worker} from 'node:worker_threads';
import {workerEntry} from '../runtime/worker-entry.ts';
import type {DeltaCalibrationInput,fitDeltaCalibration} from './delta-calibration.ts';
/** One bounded calibration per owner; cancellation joins worker termination. */
export class DeltaCalibrationExecutor {
 #busy=false;get busy(){return this.#busy;}
 async fit(input:DeltaCalibrationInput,options:{signal?:AbortSignal;timeoutMs?:number}={}):Promise<ReturnType<typeof fitDeltaCalibration>>{
  if(this.#busy)throw new Error('Delta calibration executor is busy');options.signal?.throwIfAborted();
  const timeout=options.timeoutMs??30000;
  if(!Number.isSafeInteger(timeout)||timeout<1||timeout>600000)throw new RangeError('Invalid Delta calibration timeout');
  for(const values of [input.probes,input.manual??[],input.distances??[]])if(!Array.isArray(values)||values.length>999)throw new RangeError('Delta measurement capacity exceeded');
  this.#busy=true;let worker:Worker|undefined,timer:ReturnType<typeof setTimeout>|undefined,abort:(()=>void)|undefined;
  try{
   worker=new Worker(workerEntry('./delta-calibration-worker.ts',import.meta.url),{workerData:input,resourceLimits:{maxOldGenerationSizeMb:128}});
   return await new Promise((resolve,reject)=>{
    worker!.once('message',m=>m.ok?resolve(m.result):reject(new Error(m.error)));worker!.once('error',reject);worker!.once('exit',code=>reject(new Error('Delta worker exited before returning: '+code)));
    abort=()=>reject(options.signal?.reason??new Error('Delta calibration cancelled'));options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
    timer=setTimeout(()=>reject(new Error('Delta calibration timed out')),timeout);
   });
  }finally{if(timer)clearTimeout(timer);if(abort)options.signal?.removeEventListener('abort',abort);try{await worker?.terminate();}finally{this.#busy=false;}}
 }
}
