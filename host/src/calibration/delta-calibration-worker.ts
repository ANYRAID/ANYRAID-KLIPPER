import {parentPort,workerData} from 'node:worker_threads';
import {fitDeltaCalibration} from './delta-calibration.ts';
try{parentPort!.postMessage({ok:true,result:fitDeltaCalibration(workerData)});}catch(error){parentPort!.postMessage({ok:false,error:error instanceof Error?error.message:String(error)});}
