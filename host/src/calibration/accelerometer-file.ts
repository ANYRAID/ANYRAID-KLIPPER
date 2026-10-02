import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {parseAccelerometerLog,type AccelerometerLog} from './accelerometer-log.ts';
/** Bounded file acquisition for offline tools. Parsing remains synchronous. */
export async function readAccelerometerLog(filename:string,signal:AbortSignal,maxBytes=64*1024**2):Promise<AccelerometerLog>{
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>64*1024**2)throw new RangeError('Invalid accelerometer file limit');
 signal.throwIfAborted();const file=await open(filename,constants.O_RDONLY|constants.O_NONBLOCK);
 try{
  signal.throwIfAborted();const stat=await file.stat();if(!stat.isFile())throw new Error('Accelerometer input must be a regular file');if(stat.size>maxBytes)throw new RangeError('Accelerometer file limit exceeded');
  const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}),chunks:string[]=[];let bytes=0;
  const stream=file.createReadStream({autoClose:false,highWaterMark:65536,signal});
  try{for await(const chunk of stream){bytes+=(chunk as Buffer).length;if(bytes>maxBytes)throw new RangeError('Accelerometer file limit exceeded');chunks.push(decoder.decode(chunk as Buffer,{stream:true}));}chunks.push(decoder.decode());}
  finally{stream.destroy();}
  signal.throwIfAborted();const result=parseAccelerometerLog(chunks.join(''),filename);signal.throwIfAborted();return result;
 }finally{await file.close();}
}
