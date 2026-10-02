import type {TemperatureWaitTimer} from './temperature-wait.ts';
const timer:Pick<TemperatureWaitTimer,'schedule'>={schedule(callback,seconds){const handle=setTimeout(callback,seconds*1000);return ()=>clearTimeout(handle);}};
/** Sensor polling keeps its own deadline. Success stops future checkpoints but
 * awaits the active one; faults abort both owners and still await retirement. */
export async function withTemperatureCheckpoints(wait:(signal:AbortSignal)=>Promise<void>,checkpoint:(signal:AbortSignal)=>Promise<void>,signal:AbortSignal,clock:Pick<TemperatureWaitTimer,'schedule'>=timer):Promise<void>{
 signal.throwIfAborted();const stop=new AbortController(),local=AbortSignal.any([signal,stop.signal]);let done=false,wake=()=>{};
 const finish=()=>{done=true;wake();};local.addEventListener('abort',finish,{once:true});
 const waiting=Promise.resolve().then(()=>wait(local)).then(finish,error=>{stop.abort(error);finish();throw error;});
 const maintenance=(async()=>{
  try{
   while(!done){
    await new Promise<void>((resolve,reject)=>{let cancel=()=>{},settled=false;wake=()=>{if(settled)return;settled=true;try{cancel();resolve();}catch(error){reject(error);}};cancel=clock.schedule(wake,1);if(done||local.aborted)wake();});
    if(done)break;local.throwIfAborted();await checkpoint(local);
   }
  }catch(error){stop.abort(error);finish();throw error;}
 })();
 try{
  const results=await Promise.allSettled([waiting,maintenance]),errors=[...new Set(results.filter(r=>r.status==='rejected').map(r=>r.reason))];
  if(errors.length===1)throw errors[0];if(errors.length)throw new AggregateError(errors,'Temperature wait and checkpoint failed');local.throwIfAborted();
 }finally{finish();local.removeEventListener('abort',finish);}
}
