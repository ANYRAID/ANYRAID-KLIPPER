import {parentPort,workerData} from 'node:worker_threads';
import {MotanLogManager} from './log-manager.ts';
import {MotanAnalyzer} from './analyzer.ts';
import type {MotanAnalysisRequest} from './analysis-executor.ts';

async function analyze(request:MotanAnalysisRequest){
  const manager=await MotanLogManager.open(request.prefix,{start:request.start});
  try{
    parentPort!.postMessage({type:'analyzing'});
    const analyzer=new MotanAnalyzer(manager,request.segmentTime!,{
      maxSamples:request.maxSamples,maxNumericBytes:request.maxNumericBytes,
    });
    for(const name of request.datasets)analyzer.addDataset(name);
    return await analyzer.generate(request.duration);
  }finally{await manager.close();}
}

try{
  const result=await analyze(workerData),buffers=new Set<ArrayBuffer>();
  for(const values of [result.times,...Object.values(result.datasets)]){
    if(!(values.buffer instanceof ArrayBuffer)||values.byteOffset!==0||values.byteLength!==values.buffer.byteLength)
      throw new Error('Motan result requires owned numeric buffers');
    buffers.add(values.buffer);
  }
  parentPort!.postMessage({type:'result',result},[...buffers]);
}catch(error){parentPort!.postMessage({type:'error',error:error instanceof Error?error.message:String(error)});}
finally{parentPort!.close();}
