import type {IncomingMessage} from 'node:http';
/** Give a small body already in flight time to finish before Connection: close.
 * Never parse/store it. Bound both bytes and time; oversized or stalled clients
 * still receive an early rejection and may observe a transport write failure. */
export function discardRejectedUploadBody(request:IncomingMessage,signal:AbortSignal):Promise<void>{
 const maximumBytes=65536,timeoutMs=250,length=request.headers['content-length'];
 if(request.readableEnded||request.destroyed||signal.aborted)return Promise.resolve();
 if(length!==undefined&&(!/^\d+$/.test(length)||Number(length)>maximumBytes))return Promise.resolve();
 return new Promise(resolve=>{
  let bytes=0,settled=false;
  const finish=()=>{if(settled)return;settled=true;clearTimeout(timer);request.pause();request.off('data',data);request.off('end',finish);request.off('error',finish);request.off('close',finish);signal.removeEventListener('abort',finish);resolve();};
  const data=(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>maximumBytes)finish();};
  const timer=setTimeout(finish,timeoutMs);
  request.on('data',data);request.once('end',finish);request.once('error',finish);request.once('close',finish);signal.addEventListener('abort',finish,{once:true});
  if(signal.aborted||request.destroyed)finish();else request.resume();
 });
}
