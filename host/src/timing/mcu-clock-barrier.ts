import {performance} from 'node:perf_hooks';
import type {ClockRuntime,ClockScheduler} from './clock-runtime.ts';
export interface McuClockTarget {clock:Pick<ClockRuntime,'assertActive'|'sync'>;tick:bigint;}
const scheduler:ClockScheduler={now:()=>performance.now()/1000,schedule(callback,seconds){const timer=setTimeout(callback,seconds*1000);return ()=>clearTimeout(timer);}};
/** Wait for fresh, healthy sampled MCU clocks strictly beyond all target ticks.
 * Caller must first flush all motion generation/transport and await acceptance.
 * This is a firmware-time barrier, not physical position feedback or a stop. */
export function waitForMcuClocks(targets:readonly McuClockTarget[],signal:AbortSignal,options:{timeoutSeconds?:number;pollSeconds?:number;scheduler?:ClockScheduler}={}):Promise<void>{
 return new Promise((resolve,reject)=>{
  let done=false,cancel=()=>{};
  const finish=(failed:boolean,error?:unknown)=>{if(done)return;done=true;try{cancel();}catch(cleanup){error=failed?new AggregateError([error,cleanup],'MCU clock wait cleanup failed'):cleanup;failed=true;}signal.removeEventListener('abort',abort);if(failed)reject(error);else resolve();};
  const abort=()=>finish(true,signal.reason??new Error('MCU clock wait aborted'));
  try{
   signal.throwIfAborted();const timeout=options.timeoutSeconds??30,poll=options.pollSeconds??.01,timing=options.scheduler??scheduler;
   if(!Array.isArray(targets)||!targets.length||targets.length>128||!Number.isFinite(timeout)||timeout<=0||timeout>3600||!Number.isFinite(poll)||poll<=0||poll>1)throw new RangeError('Invalid MCU clock barrier limits');
   const owned=targets.map(({clock,tick})=>{if(typeof tick!=='bigint'||tick<0n||tick>=0xffffffffffffffffn)throw new RangeError('Invalid target MCU clock');clock.assertActive();return {clock,tick,sync:clock.sync,last:clock.sync.lastClock};});
   let last=timing.now();if(!Number.isFinite(last)||last<0)throw new Error('Invalid monotonic time');const deadline=last+timeout;if(!Number.isFinite(deadline)||deadline<=last)throw new RangeError('Unrepresentable clock wait deadline');
   const check=()=>{if(done)return;try{signal.throwIfAborted();const now=timing.now();if(!Number.isFinite(now)||now<last)throw new Error('Monotonic clock regressed');last=now;if(now>=deadline)throw new Error('MCU clock barrier timed out');let complete=true;
    for(const t of owned){t.clock.assertActive();if(t.clock.sync!==t.sync||t.sync.lastClock<t.last)throw new Error('MCU clock generation changed');t.last=t.sync.lastClock;if(t.last<=t.tick)complete=false;}
    if(complete){finish(false);return;}cancel=timing.schedule(check,Math.min(poll,deadline-now));
   }catch(error){finish(true,error);}};
   signal.addEventListener('abort',abort,{once:true});check();
  }catch(error){finish(true,error);}
 });
}
