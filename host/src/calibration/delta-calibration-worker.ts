import {parentPort,workerData} from 'node:worker_threads';
import {fitDeltaCalibration} from './delta-calibration.ts';
try{const result=fitDeltaCalibration(workerData);if(!result.search.converged)throw new Error('Delta calibration did not converge: '+result.search.reason);parentPort!.postMessage({ok:true,result});}catch(error){parentPort!.postMessage({ok:false,error:error instanceof Error?error.message:String(error)});}
