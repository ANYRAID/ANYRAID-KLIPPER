import {workerEntry} from '../runtime/worker-entry.ts';
import { Worker } from 'node:worker_threads';
import type { Spectrum } from './spectrum.ts';
/** Single-flight executor: calibration cannot silently accumulate CPU/memory jobs. */
export class SpectrumExecutor {
  #busy=false;
  get busy():boolean { return this.#busy; }
  /** Transfers ownership of the entire sample buffer; callers must not reuse it. */
  async calculate(name:string,samples:Float64Array,options:{signal?:AbortSignal; timeoutMs?:number}={}):Promise<Spectrum|null> {
    if(this.#busy) throw new Error('Calibration executor is busy');
    options.signal?.throwIfAborted();
    const timeoutMs=options.timeoutMs??60000;
    if(!Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>600000) throw new RangeError('Invalid calibration timeout');
    if(!(samples.buffer instanceof ArrayBuffer) || samples.byteOffset!==0 || samples.byteLength!==samples.buffer.byteLength || samples.length>16_000_000)
      throw new RangeError('A bounded, exclusively owned sample buffer is required');
    this.#busy=true;
    let worker:Worker|undefined;
    let timer:ReturnType<typeof setTimeout>|undefined;
    let abort:(()=>void)|undefined;
    try {
      worker=new Worker(workerEntry('./spectrum-worker.ts',import.meta.url),{workerData:{name,samples},transferList:[samples.buffer],resourceLimits:{maxOldGenerationSizeMb:256}});
      return await new Promise<Spectrum|null>((resolve,reject) => {
        worker!.once('message',message => message.ok ? resolve(message.result) : reject(new Error(message.error)));
        worker!.once('error',reject);
        worker!.once('exit',code => reject(new Error(`Calibration worker exited before returning: ${code}`)));
        abort=() => reject(options.signal?.reason??new Error('Calibration cancelled'));
        options.signal?.addEventListener('abort',abort,{once:true});
        timer=setTimeout(() => reject(new Error('Calibration timed out')),timeoutMs);
      });
    } finally {
      if(timer) clearTimeout(timer);
      if(abort) options.signal?.removeEventListener('abort',abort);
      // Do not release the CPU slot until a cancelled worker is actually dead.
      try { if(worker) await worker.terminate(); } finally { this.#busy=false; }
    }
  }
}
