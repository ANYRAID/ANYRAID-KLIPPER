// TMC2208/2209 error masks from klippy/extras/tmc.py. GPL-3.0-or-later.
import type {TmcUartDevice} from './tmc-uart.ts';
export interface TmcMonitorTimer {schedule(callback:()=>void,seconds:number):()=>void;}
const timer:TmcMonitorTimer={schedule(callback,seconds){const id=setTimeout(callback,seconds*1000);return ()=>clearTimeout(id);}};
/** Powered-driver monitoring remains active while idle. Startup may clear
 * latched GSTAT once with motors disabled; runtime never clears or reinitializes
 * a fault. All reads serialize with other UART transactions on the MCU. */
export class Tmc220xMonitor {
 #device:Pick<TmcUartDevice,'read'|'write'>;#fault:(error:unknown)=>void;#timer:TmcMonitorTimer;
 #abort=new AbortController();#pending:Promise<void>|undefined;#cancel:(()=>void)|undefined;#started=false;#closed=false;
 #drv:number|null=null;#gstat:number|null=null;#error:unknown;#checks=0;
 constructor(device:Pick<TmcUartDevice,'read'|'write'>,fault:(error:unknown)=>void,clock:TmcMonitorTimer=timer){this.#device=device;this.#fault=fault;this.#timer=clock;}
 get status(){return {closed:this.#closed,checks:this.#checks,drvStatus:this.#drv,gstat:this.#gstat,warnings:this.#drv===null?null:this.#drv&0xf01,fault:this.#error};}
 async #check(startup:boolean){
  const signal=this.#abort.signal;
  for(const [register,mask] of [[0x6f,0x3e],[1,0xffffffff]]){
   let cleared=false;
   for(let attempt=0;attempt<3;attempt++){
    signal.throwIfAborted();const value=await this.#device.read(register,signal);signal.throwIfAborted();
    if(!Number.isInteger(value)||value<0||value>0xffffffff)throw new Error('Malformed TMC status');
    if(register===1)this.#gstat=value;else this.#drv=value;
    if((value&mask)===0)break;
    if(attempt===2)throw new Error(`TMC driver fault register ${register.toString(16)} value ${value.toString(16)}`);
    if(startup&&register===1&&!cleared){await this.#device.write(1,value,signal);cleared=true;}
   }
  }
  this.#checks++;
 }
 async start(signal:AbortSignal):Promise<void>{
  signal.throwIfAborted();if(this.#started||this.#closed)throw new Error('TMC monitor cannot restart');this.#started=true;
  const abort=()=>this.#abort.abort(signal.reason);signal.addEventListener('abort',abort,{once:true});
  const pending=this.#check(true);this.#pending=pending;
  try{await pending;this.#abort.signal.throwIfAborted();this.#schedule();}catch(error){this.#error=error;this.#closed=true;this.#abort.abort(error);throw error;}
  finally{if(this.#pending===pending)this.#pending=undefined;signal.removeEventListener('abort',abort);}
 }
 #schedule(){this.#cancel=this.#timer.schedule(()=>{
  this.#cancel=undefined;if(this.#closed)return;const pending=this.#check(false);this.#pending=pending;
  void pending.then(()=>{if(this.#pending===pending)this.#pending=undefined;if(!this.#closed)this.#schedule();},error=>{
   if(this.#pending===pending)this.#pending=undefined;if(this.#closed)return;this.#error=error;this.#closed=true;this.#abort.abort(error);this.#fault(error);
  });
 },1);}
 async stop(cause:unknown=new Error('TMC monitor stopped')):Promise<void>{this.#closed=true;this.#cancel?.();this.#cancel=undefined;this.#abort.abort(cause);await this.#pending?.catch(()=>{});}
}
