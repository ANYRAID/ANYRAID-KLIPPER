import {StepperStopFence} from './stepper-stop-fence.ts';
import type {AcceptedFirmwareCommand} from './serial-firmware.ts';

type Batch={first:bigint;interval:bigint;add:bigint;count:number;done:number;direction:number};
/** Test-only ideal scheduled pulse counter. Receipt is not execution. Compare
 * against the actual C handlers; this is not a physical timing simulation. */
export class StepperExecutedCounter extends StepperStopFence {
 #positions=new Map<number,number>();
 #pending=new Map<number,Batch[]>();
 #bindings=new Map<number,Set<number>>();
 #clock:bigint|undefined;
 readonly #publish:(oid:number,position:number)=>void;
 readonly #stopped:((oid:number)=>void)|undefined;
 constructor(clock:()=>number,publish:(oid:number,position:number)=>void,stopped?:(oid:number)=>void){super(clock);this.#publish=publish;this.#stopped=stopped;}
 #now():bigint{
  const raw=BigInt(this.currentClock()>>>0);
  const delta=this.#clock===undefined?0n:BigInt.asIntN(32,raw-BigInt.asUintN(32,this.#clock));if(delta<0n)throw new Error('Fixture clock moved backward or outside retained32bit window');
  this.#clock=this.#clock===undefined?raw:this.#clock+delta;
  return this.#clock;
 }
 #settle(now:bigint):void{
  for(const [oid,batches] of this.#pending){
   let position=this.#positions.get(oid)??0;
   for(const batch of batches){
    // Strictly positive intervals make the executed prefix monotonic. Use
    // integer clocks through negative add and32bit wrap, never elapsed JS time.
    let low=batch.done,high=batch.count;
    while(low<high){const middle=Math.ceil((low+high)/2),n=BigInt(middle-1),at=batch.first+n*batch.interval+batch.add*n*(n+1n)/2n;if(at<=now)low=middle;else high=middle-1;}
    position+=batch.direction*(low-batch.done);batch.done=low;
   }
   if(position!==(this.#positions.get(oid)??0)){this.#positions.set(oid,position);this.#publish(oid,position);}
   const retained=batches.filter(batch=>batch.done<batch.count);if(retained.length)this.#pending.set(oid,retained);else this.#pending.delete(oid);
  }
 }
 seedPosition(oid:number,position:number):void{
  if(!Number.isInteger(position)||position<-2147483648||position>2147483647)throw new RangeError('Invalid fixture stepper position');
  this.#settle(this.#now());this.#positions.set(oid,position);this.#publish(oid,position);
 }
 position(oid:number):number{this.#settle(this.#now());return this.#positions.get(oid)??0;}
 synchronize():void{this.#settle(this.#now());}
 override trigger(oid:number):void{
  this.#settle(this.#now());const bound=[...this.#bindings.get(oid)??[]];for(const stepper of bound)this.#pending.delete(stepper);
  this.#bindings.delete(oid);super.trigger(oid);
  // An explicit fixture halt oracle may replace the reported position only
  // after this MCU stops its own bound motor. Other MCUs keep their ownership.
  for(const stepper of bound)this.#stopped?.(stepper);
 }
 override observe(command:AcceptedFirmwareCommand):boolean{
  const now=this.#now();this.#settle(now);const {name,parameters:p}=command,oid=Number(p.oid);
  const accepted=super.observe(command);
  if(name==='trsync_start')this.#bindings.set(oid,new Set());
  else if(name==='stepper_stop_on_trigger')this.#bindings.get(Number(p.trsync_oid))!.add(oid);
  else if(name==='reset_step_clock'){
   if(this.#pending.has(oid))throw new Error('Fixture reset while scheduled steps remain');
  }else if(name==='queue_step'&&accepted){
   const event=this.observation.events.at(-1) as {firstClock?:number};
   if(event.firstClock===undefined)throw new Error('Fixture step clock was not initialized');
   const count=Number(p.count),interval=BigInt(Number(p.interval)),add=BigInt(Number(p.add));
   if(!Number.isInteger(count)||count<1||count>65535||interval<=0n||interval+add*BigInt(count-1)<=0n)throw new RangeError('Invalid fixture step batch');
   const batches=this.#pending.get(oid)??[];if(batches.length>=512)throw new Error('Fixture scheduled step capacity exceeded');
   const first=now+BigInt.asIntN(32,BigInt(event.firstClock)-BigInt.asUintN(32,now));
   batches.push({first,interval,add,count,done:0,direction:this.direction(oid)});this.#pending.set(oid,batches);this.#settle(now);
  }
  return accepted;
 }
}
