// BLTouch command timing from klippy/extras/bltouch.py (GPL-3.0-or-later).
export const BLTOUCH_PERIOD=.020;
export const BLTOUCH_MIN_COMMAND_TIME=5*BLTOUCH_PERIOD;
export const BLTOUCH_COMMANDS=Object.freeze({pin_down:.000650,touch_mode:.001165,pin_up:.001475,self_test:.001780,reset:.002190,set_5V_output_mode:.001988,set_OD_output_mode:.002091,output_mode_store:.001884});
export type BLTouchCommand=keyof typeof BLTOUCH_COMMANDS;
export interface BLTouchClock {
 clockAt(time:number):bigint;
 printAt(clock:bigint):number;
 secondsToClock(seconds:number):bigint;
}
/** Keep the end clock integral: adding clock ticks as Number loses precision
 * on long-running/high-frequency MCUs. Duration truncation follows Python int. */
export function planBLTouchCommand(clock:BLTouchClock,command:BLTouchCommand,start:number,duration=BLTOUCH_MIN_COMMAND_TIME){
 if(!Object.hasOwn(BLTOUCH_COMMANDS,command)||!Number.isFinite(start)||start<0||!Number.isFinite(duration)||duration<=0)throw new RangeError('Invalid BLTouch command');
 const pulse=Math.trunc((duration-BLTOUCH_MIN_COMMAND_TIME)/BLTOUCH_PERIOD)*BLTOUCH_PERIOD;
 const startClock=clock.clockAt(start),ticks=clock.secondsToClock(Math.max(BLTOUCH_MIN_COMMAND_TIME,pulse));
 if(typeof startClock!=='bigint'||startClock<0n||typeof ticks!=='bigint'||ticks<=0n)throw new RangeError('Invalid BLTouch clock');
 const endClock=startClock+ticks;if(endClock>=0x7fffffffffffffffn)throw new RangeError('BLTouch clock overflow');
 const end=clock.printAt(endClock),actionEnd=start+duration,next=Math.max(actionEnd,end+BLTOUCH_MIN_COMMAND_TIME);
 if(![end,actionEnd,next].every(Number.isFinite)||end<=start||actionEnd<=start||next<=end)throw new RangeError('Unrepresentable BLTouch timing');
 return Object.freeze({command,start,startClock,end,endClock,duty:BLTOUCH_COMMANDS[command]/BLTOUCH_PERIOD,actionEnd,next});
}
export interface BLTouchCommandPort extends BLTouchClock {
 setPWM(time:number,duty:number,signal:AbortSignal):Promise<void>;
 /** Must fence pending writes and force the configured safe output. */
 stop(cause:unknown):Promise<void>;
}
/** Device command ownership only. A probe adapter must additionally wait for
 * MCU time and verify the sensor before allowing any descent. */
export class BLTouchCommandQueue {
 #port:BLTouchCommandPort;#next=0;#actionEnd=0;#busy=false;#failed=false;#stop:Promise<void>|undefined;
 constructor(port:BLTouchCommandPort){this.#port=port;}
 get status(){return {nextCommandTime:this.#next,actionEndTime:this.#actionEnd,busy:this.#busy,failed:this.#failed};}
 stop(cause:unknown):Promise<void>{if(this.#stop)return this.#stop;this.#failed=true;this.#stop=Promise.resolve().then(()=>this.#port.stop(cause));return this.#stop;}
 async send(command:BLTouchCommand,earliest:number,signal:AbortSignal,duration=BLTOUCH_MIN_COMMAND_TIME){
  if(this.#failed)throw new Error('BLTouch command queue stopped');
  if(this.#busy)throw new Error('BLTouch command already active');
  signal.throwIfAborted();if(!Number.isFinite(earliest)||earliest<0)throw new RangeError('Invalid BLTouch earliest time');
  const plan=planBLTouchCommand(this.#port,command,Math.max(earliest,this.#next),duration);this.#busy=true;
  const abort=()=>{void this.stop(signal.reason).catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
  try{
   await this.#port.setPWM(plan.start,plan.duty,signal);signal.throwIfAborted();
   if(this.#failed)throw new Error('BLTouch command queue stopped');
   await this.#port.setPWM(plan.end,0,signal);signal.throwIfAborted();
   if(this.#failed)throw new Error('BLTouch command queue stopped');
   this.#next=plan.next;this.#actionEnd=plan.actionEnd;return plan;
  }catch(error){try{await this.stop(error);}catch(stop){throw new AggregateError([error,stop],'BLTouch command and output stop failed');}throw error;}
  finally{signal.removeEventListener('abort',abort);this.#busy=false;}
 }
}
