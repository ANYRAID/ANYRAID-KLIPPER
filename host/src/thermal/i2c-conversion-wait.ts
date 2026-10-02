import {setTimeout as delay} from 'node:timers/promises';
/** Timers may fire before the monotonic deadline at millisecond boundaries.
 * Recheck elapsed time before accessing a sensor's conversion registers. */
export async function waitI2cConversion(ms:number,signal:AbortSignal,now:()=>number=()=>performance.now(),pause:(ms:number,signal:AbortSignal)=>Promise<void>=async(ms,signal)=>{await delay(ms,undefined,{signal});}){
 if(!Number.isFinite(ms)||ms<0)throw Error('Invalid I2C conversion wait');signal.throwIfAborted();
 const deadline=now()+ms;let remaining=ms;
 while(remaining>0){await pause(Math.ceil(remaining),signal);signal.throwIfAborted();remaining=deadline-now();}
}
