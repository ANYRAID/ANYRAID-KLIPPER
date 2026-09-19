// Bounded asynchronous port of SerialReader._get_identify_data (GPL-3.0-or-later).
import { performance } from 'node:perf_hooks';
import { MessageDictionary } from './dictionary.ts';
import type { DecodedMessage } from './dictionary.ts';
import { ProtocolError } from './codec.ts';
/** Transport must stop retries/writes when signal aborts; it owns wire ACK/retry logic. */
export type IdentifyQuery=(payload:Uint8Array,signal:AbortSignal)=>Promise<DecodedMessage>;
export interface IdentifyOptions {
  signal?:AbortSignal;
  timeoutMs?:number;
  maxBytes?:number;
  maxStaleResponses?:number;
}
/** Returns a fully validated new dictionary; never modifies the active connection. */
export async function downloadIdentify(query:IdentifyQuery,options:IdentifyOptions={}):Promise<MessageDictionary> {
  const timeoutMs=options.timeoutMs??5000,maxBytes=options.maxBytes??1024*1024,maxStale=options.maxStaleResponses??8;
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000
    ||!Number.isInteger(maxBytes)||maxBytes<1||maxBytes>4*1024*1024
    ||!Number.isInteger(maxStale)||maxStale<0||maxStale>1000) throw new RangeError('Invalid identify bounds');
  options.signal?.throwIfAborted();
  const cancellation=new AbortController(),bootstrap=new MessageDictionary();
  const deadline=performance.now()+timeoutMs;
  const abort=()=>cancellation.abort(options.signal?.reason??new Error('Identify cancelled'));
  options.signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>cancellation.abort(new Error('Identify timed out')),timeoutMs);
  let storage=new Uint8Array(Math.min(1024,maxBytes)),offset=0,stale=0;
  try {
    while(true) {
      // A synchronously resolving transport must not starve the timeout callback.
      if(performance.now()>=deadline) cancellation.abort(new Error('Identify timed out'));
      cancellation.signal.throwIfAborted();
      const payload=bootstrap.encode('identify',{offset,count:40});
      const response=await cancellableQuery(query,payload,cancellation.signal);
      cancellation.signal.throwIfAborted();
      if(performance.now()>=deadline) throw new Error('Identify timed out');
      if(response.name!=='identify_response') throw new ProtocolError('Unexpected identify response');
      const position=response.parameters.offset,chunk=response.parameters.data;
      if(typeof position!=='number'||!Number.isInteger(position)||position<0||position>0xffffffff
        ||!(chunk instanceof Uint8Array)||chunk.length>40) throw new ProtocolError('Malformed identify response');
      if(position!==offset) {
        if(++stale>maxStale) throw new ProtocolError('Identify made no progress');
        continue;
      }
      stale=0;
      if(!chunk.length) {
        if(!offset) throw new ProtocolError('Empty firmware dictionary');
        const dictionary=new MessageDictionary();dictionary.identify(storage.subarray(0,offset));
        if(performance.now()>=deadline) throw new Error('Identify timed out');
        return dictionary;
      }
      if(offset+chunk.length>maxBytes) throw new ProtocolError('Firmware dictionary exceeds download limit');
      if(offset+chunk.length>storage.length) {
        const grown=new Uint8Array(Math.min(maxBytes,Math.max(storage.length*2,offset+chunk.length)));
        grown.set(storage);storage=grown;
      }
      storage.set(chunk,offset);offset+=chunk.length;
    }
  } finally {
    clearTimeout(timer);options.signal?.removeEventListener('abort',abort);
    // Also invalidate a transport that ignored an earlier error or timeout.
    cancellation.abort(new Error('Identify session ended'));
  }
}
function cancellableQuery(query:IdentifyQuery,payload:Uint8Array,signal:AbortSignal):Promise<DecodedMessage> {
  return new Promise((resolve,reject)=>{
    const aborted=()=>{signal.removeEventListener('abort',aborted);reject(signal.reason);};
    signal.addEventListener('abort',aborted,{once:true});
    if(signal.aborted) {aborted();return;}
    Promise.resolve().then(()=>{signal.throwIfAborted();return query(payload,signal);}).then(
      result=>{signal.removeEventListener('abort',aborted);resolve(result);},
      error=>{signal.removeEventListener('abort',aborted);reject(error);}
    );
  });
}
