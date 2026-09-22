import {Worker} from 'node:worker_threads';
import type {MotanAnalysis} from './analyzer.ts';

export interface MotanAnalysisRequest {
  prefix:string;
  datasets:readonly string[];
  segmentTime?:number;
  duration?:number;
  start?:number;
  maxSamples?:number;
  maxNumericBytes?:number;
}
export interface MotanAnalysisControl {signal?:AbortSignal;timeoutMs?:number;}

function snapshot(request:MotanAnalysisRequest):MotanAnalysisRequest {
  const {prefix,segmentTime=.0001,duration=5,start=0,maxSamples=1000000,
    maxNumericBytes=64*1024**2}=request;
  if(typeof prefix!=='string'||!prefix.length||prefix.length>4096||prefix.includes('\0')
     ||!Array.isArray(request.datasets)||!request.datasets.length||request.datasets.length>256)
    throw new Error('Invalid Motan analysis request');
  const datasets=[...request.datasets];
  if(datasets.some(name=>typeof name!=='string'||!name.length||name.length>4096)
     ||Buffer.byteLength(JSON.stringify(datasets))>65536)
    throw new Error('Motan analysis dataset request limit');
  if(!Number.isFinite(segmentTime)||segmentTime<=0||!Number.isFinite(duration)||duration<0
     ||!Number.isFinite(start)||!Number.isSafeInteger(maxSamples)||maxSamples<1||maxSamples>2000000
     ||!Number.isSafeInteger(maxNumericBytes)||maxNumericBytes<1||maxNumericBytes>512*1024**2)
    throw new Error('Invalid Motan analysis request limits');
  return {prefix,datasets,segmentTime,duration,start,maxSamples,maxNumericBytes};
}

function receive(result:MotanAnalysis,maxBytes:number):MotanAnalysis {
  if(!result||!(result.times instanceof Float64Array)||!result.datasets||!result.labels)
    throw new Error('Invalid Motan worker result');
  const entries=Object.entries(result.datasets);
  if(entries.length>256||entries.length!==Object.keys(result.labels).length)
    throw new Error('Invalid Motan worker datasets');
  let bytes=result.times.byteLength;
  for(const [name,values]of entries){
    const label=result.labels[name];
    if(!(values instanceof Float64Array)||values.length!==result.times.length
       ||!label||label.name!==name||typeof label.label!=='string'||typeof label.units!=='string')
      throw new Error('Invalid Motan worker column');
    bytes+=values.byteLength;Object.freeze(label);
  }
  if(bytes>maxBytes)throw new Error('Motan worker result budget exceeded');
  const datasets=Object.freeze(Object.assign(Object.create(null),result.datasets));
  const labels=Object.freeze(Object.assign(Object.create(null),result.labels));
  return Object.freeze({times:result.times,datasets,labels});
}

/** One active job per owner. Results transfer their buffers from the worker;
 * cancellation/close waits for worker termination before releasing admission. */
export class MotanAnalysisExecutor {
  #active:Promise<MotanAnalysis>|undefined;
  #closed=false;
  #phase:'idle'|'starting'|'analyzing'='idle';
  #cancel:((reason:unknown)=>void)|undefined;
  get status(){return {busy:this.#active!==undefined,closed:this.#closed,phase:this.#phase};}

  async analyze(request:MotanAnalysisRequest,control:MotanAnalysisControl={}):Promise<MotanAnalysis>{
    if(this.#closed)throw new Error('Motan analysis executor closed');
    if(this.#active)throw new Error('Motan analysis executor busy');
    const signal=control.signal;
    signal?.throwIfAborted();
    const input=snapshot(request),timeout=control.timeoutMs??60000;
    if(!Number.isSafeInteger(timeout)||timeout<1||timeout>600000)throw new Error('Invalid Motan analysis timeout');
    const pending=this.#run(input,signal,timeout);this.#active=pending;
    try{
      const result=await pending;
      signal?.throwIfAborted();
      if(this.#closed)throw new Error('Motan analysis executor closed');
      return result;
    }finally{this.#active=undefined;}
  }

  async #run(request:MotanAnalysisRequest,signal:AbortSignal|undefined,timeout:number):Promise<MotanAnalysis>{
    let worker:Worker|undefined,timer:ReturnType<typeof setTimeout>|undefined,abort:(()=>void)|undefined;
    this.#phase='starting';
    try{
      worker=new Worker(new URL('./analysis-worker.ts',import.meta.url),{
        workerData:request,trackUnmanagedFds:true,resourceLimits:{maxOldGenerationSizeMb:256},
      });
      return await new Promise<MotanAnalysis>((resolve,reject)=>{
        this.#cancel=reject;
        worker!.on('message',message=>{
          if(message?.type==='analyzing'){this.#phase='analyzing';return;}
          if(message?.type==='result'){
            try{resolve(receive(message.result,request.maxNumericBytes!));}catch(error){reject(error);}
          }else reject(new Error(message?.type==='error'?String(message.error):'Invalid Motan worker message'));
        });
        worker!.once('error',reject);
        worker!.once('exit',code=>reject(new Error(`Motan worker exited before returning: ${code}`)));
        abort=()=>reject(signal?.reason??new Error('Motan analysis cancelled'));
        signal?.addEventListener('abort',abort,{once:true});
        timer=setTimeout(()=>reject(new Error('Motan analysis timed out')),timeout);
        if(signal?.aborted)abort();
      });
    }finally{
      if(timer)clearTimeout(timer);if(abort)signal?.removeEventListener('abort',abort);
      this.#cancel=undefined;
      try{if(worker)await worker.terminate();}finally{worker?.removeAllListeners();this.#phase='idle';}
    }
  }

  close():Promise<void>{
    this.#closed=true;this.#cancel?.(new Error('Motan analysis executor closed'));
    return this.#active?.then(()=>undefined,()=>undefined)??Promise.resolve();
  }
}
