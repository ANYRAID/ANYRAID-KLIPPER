import type {ConfigurationReader} from '../moonraker/config-reader.ts';
export function readProductIdleTimeout(reader:ConfigurationReader):number{
 if(!reader.hasSection('idle_timeout'))return 600;
 const config=reader.section('idle_timeout');if(config.get('gcode',{defaultValue:''}).trim())throw new Error('Idle timeout macros require typed operations');
 return config.getFloat('timeout',{defaultValue:600,above:0,maxval:86400});
}
export interface IdleObservation {busy:boolean;printing:boolean;key:string;}
export interface IdleClock {now():number;schedule(callback:()=>void,seconds:number):()=>void;}
/** One monotonic timer. Successful expiry is one-shot until new activity.
 * The enclosing printer owns accepted output/cancel work during close. */
export class ProductIdleTimeout {
 #abort=new AbortController();#cancel:(()=>void)|undefined;#pending=false;#expired=false;#key:string|undefined;#last:number;#printingSince:number|undefined;#busy=false;
 private seconds:number;private clock:IdleClock;private read:()=>IdleObservation;private expire:(signal:AbortSignal)=>Promise<void>;private fault:(error:unknown)=>void;
 constructor(seconds:number,clock:IdleClock,read:()=>IdleObservation,expire:(signal:AbortSignal)=>Promise<void>,fault:(error:unknown)=>void){
  if(!Number.isFinite(seconds)||seconds<=0||seconds>86400)throw new RangeError('Invalid idle timeout');this.seconds=seconds;this.clock=clock;this.read=read;this.expire=expire;this.fault=fault;this.#last=clock.now();this.#tick();
 }
 get status(){return {state:this.#printingSince!==undefined?'Printing':this.#expired?'Idle':'Ready',printing_time:this.#printingSince===undefined?0:Math.max(0,this.clock.now()-this.#printingSince),idle_timeout:this.seconds,expired:this.#expired,closed:this.#abort.signal.aborted};}
 get updatable():boolean{return !this.#abort.signal.aborted&&!this.#pending;}
 /** Runtime-only setting. Restart the inactivity interval once, without
  * interrupting accepted safety work or changing the printer configuration. */
 setTimeout(seconds:number):void{
  if(!Number.isFinite(seconds)||seconds<=0||seconds>86400)throw new RangeError('Invalid idle timeout');
  if(this.#abort.signal.aborted||this.#pending)throw new Error('Idle timeout owner closed or expiring');
  const now=this.clock.now();if(!Number.isFinite(now)||now<this.#last)throw new Error('Invalid idle clock');
  this.#cancel?.();this.#cancel=undefined;this.seconds=seconds;this.#last=now;this.#expired=false;this.#schedule();
 }
 #schedule():void{if(!this.#abort.signal.aborted)this.#cancel=this.clock.schedule(()=>{this.#cancel=undefined;this.#tick();},Math.min(1,Math.max(.05,this.seconds)));}
 #tick():void{
  if(this.#abort.signal.aborted||this.#pending)return;
  try{
   const now=this.clock.now();if(!Number.isFinite(now)||now<this.#last)throw new Error('Invalid idle clock');const observation=this.read();this.#busy=observation.busy;
   if(observation.printing)this.#printingSince??=now;else this.#printingSince=undefined;
   if(this.#key!==observation.key||observation.busy){this.#key=observation.key;this.#last=now;this.#expired=false;}
   if(!this.#busy&&!this.#expired&&now-this.#last>=this.seconds){
    this.#pending=true;
    // Invoke synchronously so admission cannot interleave with the snapshot.
    const work=this.expire(this.#abort.signal);
    void work.then(()=>{this.#pending=false;if(this.#abort.signal.aborted)return;this.#key=this.read().key;this.#expired=true;this.#schedule();}).catch(error=>{this.#pending=false;this.#fail(error);});
   }else this.#schedule();
  }catch(error){this.#pending=false;this.#fail(error);}
 }
 #fail(error:unknown):void{if(this.#abort.signal.aborted)return;this.close(error);this.fault(error);}
 close(cause:unknown=new Error('Idle timeout closed')):void{if(this.#abort.signal.aborted)return;this.#abort.abort(cause);this.#cancel?.();this.#cancel=undefined;}
}
