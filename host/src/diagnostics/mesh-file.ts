import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {parseRequestJson} from '../moonraker/json.ts';
/** Local snapshot input only; socket and WebSocket acquisition is separate work. */
export async function readMeshDump(filename:string,signal:AbortSignal,maxBytes=64*1024**2):Promise<unknown>{
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>64*1024**2)throw new RangeError('Invalid mesh input limit');signal.throwIfAborted();const file=await open(filename,constants.O_RDONLY|constants.O_NONBLOCK);
 try{signal.throwIfAborted();const stat=await file.stat();if(!stat.isFile())throw new Error('Mesh input must be a regular JSON file');if(stat.size>maxBytes)throw new RangeError('Mesh input byte limit exceeded');const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}),chunks:string[]=[];let bytes=0;const stream=file.createReadStream({autoClose:false,highWaterMark:65536,signal});try{for await(const chunk of stream){bytes+=(chunk as Buffer).length;if(bytes>maxBytes)throw new RangeError('Mesh input byte limit exceeded');chunks.push(decoder.decode(chunk as Buffer,{stream:true}));}chunks.push(decoder.decode());}finally{stream.destroy();}signal.throwIfAborted();const result=parseRequestJson(chunks.join(''));signal.throwIfAborted();return result;}finally{await file.close();}
}
