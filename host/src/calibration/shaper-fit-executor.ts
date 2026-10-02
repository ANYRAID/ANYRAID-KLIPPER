import {workerEntry} from '../runtime/worker-entry.ts';
import {Worker} from 'node:worker_threads';
import type {ShaperDataset,FitOptions,ShaperFit} from './shaper-fit.ts';
/** One active fitting job, with explicit buffer ownership and bounded termination. */
export class ShaperFitExecutor {
  #busy=false;
  get busy():boolean{return this.#busy;}
  async fit(datasets:ShaperDataset[],options:FitOptions={},control:{signal?:AbortSignal;timeoutMs?:number}={}):Promise<ShaperFit> {
    if(this.#busy)throw new Error('Shaper fit executor is busy');control.signal?.throwIfAborted();
    const timeoutMs=control.timeoutMs??60000;
    if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>600000)throw new RangeError('Invalid fit timeout');
    if(!datasets.length||datasets.length>16)throw new RangeError('Expected bounded datasets');
    const buffers=new Set<ArrayBuffer>();let samples=0;
    for(const d of datasets)for(const a of [d.frequencies,d.psd]) {
      if(!(a instanceof Float64Array)||!(a.buffer instanceof ArrayBuffer)||a.byteOffset!==0||a.byteLength!==a.buffer.byteLength||!a.length)throw new RangeError('Expected exclusively owned buffers');
      buffers.add(a.buffer);samples+=a.length;
    }
    if(samples>4_000_000)throw new RangeError('Fit input budget exceeded');
    this.#busy=true;let worker:Worker|undefined,timer:ReturnType<typeof setTimeout>|undefined,abort:(()=>void)|undefined;
    try {
      worker=new Worker(workerEntry('./shaper-fit-worker.ts',import.meta.url),{workerData:{datasets,options},transferList:[...buffers],resourceLimits:{maxOldGenerationSizeMb:256}});
      return await new Promise<ShaperFit>((resolve,reject)=>{
        worker!.once('message',message=>message.ok?resolve(message.result):reject(new Error(message.error)));
        worker!.once('error',reject);worker!.once('exit',code=>reject(new Error(`Shaper worker exited before returning: ${code}`)));
        abort=()=>reject(control.signal?.reason??new Error('Shaper fit cancelled'));control.signal?.addEventListener('abort',abort,{once:true});
        timer=setTimeout(()=>reject(new Error('Shaper fit timed out')),timeoutMs);
      });
    }finally{
      if(timer)clearTimeout(timer);if(abort)control.signal?.removeEventListener('abort',abort);
      try{if(worker)await worker.terminate();}finally{this.#busy=false;}
    }
  }
}
