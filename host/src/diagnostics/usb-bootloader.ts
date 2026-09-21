import {createRequire} from 'node:module';
interface Native {touchUSBBootloader(path:string):void;}
let native:Native|undefined;
/** One synchronous, nonblocking-open ioctl sequence; cancellation is checked
 * before and after, never retried. A completed DTR transition is not reversible. */
export async function enterUsbBootloader(path:string,signal:AbortSignal):Promise<void>{
 signal.throwIfAborted();
 native??=createRequire(import.meta.url)(process.env.ANYRAID_SERIALQUEUE_ADDON??'../../build/serialqueue.node') as Native;
 native.touchUSBBootloader(path);signal.throwIfAborted();
}
