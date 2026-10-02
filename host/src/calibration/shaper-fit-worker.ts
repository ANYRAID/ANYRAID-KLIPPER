import {parentPort,workerData} from 'node:worker_threads';
import {fitInputShapers} from './shaper-fit.ts';
try {
  const result=fitInputShapers(workerData.datasets,workerData.options),buffers=new Set<ArrayBuffer>();
  for(const candidates of result.candidates)for(const r of candidates)for(const a of [r.frequencies,r.values]) {
    if(!(a.buffer instanceof ArrayBuffer))throw new Error('Expected owned result buffer');buffers.add(a.buffer);
  }
  parentPort!.postMessage({ok:true,result},[...buffers]);
}catch(error){parentPort!.postMessage({ok:false,error:error instanceof Error?error.message:String(error)});}
