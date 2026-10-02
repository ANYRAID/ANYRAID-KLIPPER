import { parentPort, workerData } from 'node:worker_threads';
import { calculateSpectrum } from './spectrum.ts';
try {
  const result=calculateSpectrum(workerData.name,workerData.samples);
  const buffers=result ? [result.frequencies,result.x,result.y,result.z,result.sum].map(a => {
    if(!(a.buffer instanceof ArrayBuffer)) throw new Error('Expected owned result buffer');
    return a.buffer;
  }) : [];
  parentPort!.postMessage({ok:true,result},buffers);
} catch(error) {
  parentPort!.postMessage({ok:false,error:error instanceof Error ? error.message : String(error)});
}
