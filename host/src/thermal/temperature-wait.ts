export interface WaitTemperature {temperature:number;target:number;stale:boolean;fault?:string;}
export interface TemperatureWaitTimer {now():number;schedule(callback:()=>void,seconds:number):()=>void;}
const timer:TemperatureWaitTimer={now:()=>performance.now()/1000,schedule(callback,seconds){const handle=setTimeout(callback,seconds*1000);return ()=>clearTimeout(handle);}};
export interface TemperatureWaitOptions {
 minimum?:number;maximum?:number;timeoutSeconds?:number;signal:AbortSignal;
 read:()=>WaitTemperature;report:()=>void;timer?:TemperatureWaitTimer;
}
/** No temperature or target writes. Only a fresh, healthy reading can complete
 * a wait. Scheduler callbacks must run asynchronously, as setTimeout does. */
export function waitForTemperature(options:TemperatureWaitOptions):Promise<void>{
 const minimum=options.minimum??-Infinity,maximum=options.maximum??Infinity;
 if(options.minimum===undefined&&options.maximum===undefined||options.minimum!==undefined&&!Number.isFinite(minimum)||options.maximum!==undefined&&!Number.isFinite(maximum)||maximum<=minimum)return Promise.reject(new RangeError('Invalid temperature wait range'));
 return waitForTemperatureCondition({...options,ready:state=>state.temperature>=minimum&&state.temperature<=maximum});
}
export function waitForTemperatureCondition(options:Omit<TemperatureWaitOptions,'minimum'|'maximum'>&{ready:(state:WaitTemperature)=>boolean}):Promise<void>{
 const timeout=options.timeoutSeconds??1800;
 if(!Number.isFinite(timeout)||timeout<=0||timeout>86400)return Promise.reject(new RangeError('Invalid temperature wait timeout'));
 return new Promise<void>((resolve,reject)=>{
  const clock=options.timer??timer;let cancel:(()=>void)|undefined,finished=false,last=-Infinity,start:number|undefined;
  const finish=(failed:boolean,error?:unknown)=>{
   if(finished)return;finished=true;options.signal.removeEventListener('abort',abort);
   try{cancel?.();}catch(cleanup){error=failed?new AggregateError([error,cleanup],'Temperature wait and timer cleanup failed',{cause:error}):cleanup;failed=true;}
   cancel=undefined;if(failed)reject(error);else resolve();
  };
  const abort=()=>finish(true,options.signal.reason??new Error('Temperature wait aborted'));
  const poll=()=>{
   if(finished)return;
   try{
    options.signal.throwIfAborted();
    const now=clock.now();if(!Number.isFinite(now)||now<0||now<last)throw new Error('Invalid temperature wait clock');last=now;start??=now;
    if(now-start>=timeout)throw new Error('Temperature wait timed out');
    const state=options.read();
    if(state.stale||state.fault!==undefined||!Number.isFinite(state.temperature)||!Number.isFinite(state.target))throw new Error('Temperature wait requires a fresh healthy sensor');
    const ready=options.ready(state);if(typeof ready!=='boolean')throw new Error('Invalid temperature completion predicate');
    if(ready){finish(false);return;}
    options.report();options.signal.throwIfAborted();
    const stop=clock.schedule(()=>{cancel=undefined;poll();},Math.min(1,timeout-(now-start)));
    if(finished)stop();else cancel=stop;
   }catch(error){finish(true,error);}
  };
  options.signal.addEventListener('abort',abort,{once:true});poll();
 });
}
