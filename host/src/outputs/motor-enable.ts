import {MCUGroup} from '../runtime/mcu-group.ts';
import {DigitalOutput,compileDigital,type DigitalConfig} from './digital.ts';
import {snapshotPrintClock} from '../timing/print-clock.ts';
import type {MotionOutput} from '../motion/coordinator.ts';
import {serialClock} from '../protocol/serial-queue.ts';
import {decodeInteger} from '../protocol/codec.ts';
const compiledPlans=new WeakSet<object>();
export interface MotorEnableLine<T=unknown> {
 mcu:string;emitters:readonly string[];chip:T;pin:DigitalConfig<T>['pin'];oid:number;
 /** Board/driver setup margin before the first physical step, in seconds. */
 leadTime:number;calibration:Readonly<{offset:number;frequency:number}>;
}
/** Compile before configuring MCUs. Driver enables default off and do not use
 * a repeating watchdog; whole-group device shutdown supplies emergency off. */
export function compileMotorEnable<T>(group:MCUGroup,line:MotorEnableLine<T>){
 if(line.pin.chipName!==line.mcu||!Number.isFinite(line.leadTime)||line.leadTime<=0||line.leadTime>.1||!line.emitters.length||new Set(line.emitters).size!==line.emitters.length||line.emitters.some(id=>!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)))throw new Error('Invalid motor enable ownership or lead time');
 const clock=snapshotPrintClock(line.calibration),session=group.session(line.mcu);
 const config=compileDigital(line.chip,session.dictionary,{oid:line.oid,pin:line.pin,start:false,shutdown:false,maxDuration:0});
 // Resolve firmware aliases to the actual numeric GPIO identity, rather than
 // treating two names for the same pin as independently ownable outputs.
 const encoded=session.dictionary.encodeCommand(config.config),tag=decodeInteger(encoded),oid=decodeInteger(encoded,tag.next),physicalPin=decodeInteger(encoded,oid.next).value;
 const plan=Object.freeze({mcu:line.mcu,physicalPin,emitters:Object.freeze([...line.emitters]),leadTime:line.leadTime,clock,session,config});compiledPlans.add(plan);return plan;
}
type Plan=ReturnType<typeof compileMotorEnable>;
const owners=new WeakSet<Plan>();
const physicalOwners=new WeakMap<Plan['session'],{pins:Set<number>;oids:Set<number>}>();
/** Dedicated enable lines remain asserted across normal drain and homing
 * recovery. ACK confirms scheduling, not electrical driver readiness. */
export class MotorEnable {
 #group:MCUGroup;#lines:{plan:Plan;output:DigitalOutput;enabled:boolean;readyAt?:bigint}[];#byEmitter=new Map<string,number>();
 #abort=new AbortController();#off:()=>void;#busy=false;
 constructor(group:MCUGroup,plans:readonly Plan[]){
  group.assertActive();if(!plans.length||plans.length>128||new Set(plans).size!==plans.length)throw new Error('Invalid motor enable plans');
  const pins=new Set<string>(),oids=new Set<string>();
  for(const [i,p] of plans.entries()){
   const pin=`${p.mcu}:${p.physicalPin}`,oid=`${p.mcu}:${p.config.oid}`,claimed=physicalOwners.get(p.session);
   if(!compiledPlans.has(p)||owners.has(p)||claimed?.pins.has(p.physicalPin)||claimed?.oids.has(p.config.oid)||group.session(p.mcu)!==p.session||!p.session.status.configured||pins.has(pin)||oids.has(oid))throw new Error('Motor enables require dedicated configured MCU outputs');pins.add(pin);oids.add(oid);
   for(const id of p.emitters){if(this.#byEmitter.has(id))throw new Error('Motor belongs to multiple enable lines');this.#byEmitter.set(id,i);}
  }
  this.#group=group;this.#lines=plans.map(plan=>({plan,output:new DigitalOutput(plan.config,plan.session.dictionary,group.commandQueue(plan.mcu),plan.clock.clockAt),enabled:false}));
  for(const p of plans){owners.add(p);const claimed=physicalOwners.get(p.session)??{pins:new Set<number>(),oids:new Set<number>()};claimed.pins.add(p.physicalPin);claimed.oids.add(p.config.oid);physicalOwners.set(p.session,claimed);}
  this.#off=group.subscribeStop(cause=>{this.#abort.abort(cause);this.#off();});
 }
 get status(){return {stopped:this.#abort.signal.aborted,busy:this.#busy,lines:this.#lines.map(l=>({mcu:l.plan.mcu,emitters:[...l.plan.emitters],enabled:l.enabled}))};}
 assertBindings(group:MCUGroup,bindings:readonly {id:string;mcu:string;calibration:{offset:number;frequency:number}}[],printTime:number):void{
  if(group!==this.#group||bindings.length!==this.#byEmitter.size||new Set(bindings.map(b=>b.id)).size!==bindings.length)throw new Error('Motor enable binding coverage differs');
  for(const b of bindings){const i=this.#byEmitter.get(b.id),line=i===undefined?undefined:this.#lines[i],p=line?.plan;if(!p||p.mcu!==b.mcu||p.clock.offset!==b.calibration.offset||p.clock.frequency!==b.calibration.frequency)throw new Error('Motor enable physical MCU or clock differs');if(line!.readyAt!==undefined&&p.clock.clockAt(printTime)<line!.readyAt)throw new Error('Rebuilt motion precedes scheduled motor readiness');}
  this.#group.assertActive();this.#abort.signal.throwIfAborted();
 }
 /** Called inside the sink's history/commit ownership, before any step packet
  * is accepted by transport. Idle initialization records never enable motors. */
 async beforeSteps(outputs:readonly MotionOutput[]):Promise<void>{
  this.#group.assertActive();this.#abort.signal.throwIfAborted();if(this.#busy)throw new Error('Motor enable commit already active');this.#busy=true;
  try{
   const earliest=new Map<number,bigint>();
   for(const out of outputs){const index=this.#byEmitter.get(out.id);if(index===undefined)throw new Error('Unknown motor enable emitter');if(this.#lines[index].enabled)continue;
    for(let i=0;i<out.history.length;i+=6){const first=out.history[i],count=out.history[i+3];if(count===0n)continue;const prior=earliest.get(index);if(prior===undefined||first<prior)earliest.set(index,first);}
   }
   // Validate every line before submitting any enable. One shared pin receives
   // one transition at the earliest member pulse, without reference-count races.
   const requests=[...earliest].map(([index,first])=>{const line=this.#lines[index],p=line.plan,tick=first-BigInt(Math.ceil(p.leadTime*p.clock.frequency));if(tick<=p.session.clock.sync.getClock(serialClock.now()))throw new Error('Motor enable lead time exhausted');const time=p.clock.printTimeAtClock(tick);if(p.clock.clockAt(time)!==tick)throw new Error('Motor enable clock is not exactly representable');return {line,time,first};});
   await Promise.all(requests.map(({line,time})=>line.output.setDigital(time,true,this.#abort.signal)));
   this.#group.assertActive();this.#abort.signal.throwIfAborted();
   // Keep the native streamer's 25 ms minimum packet lead after all enable
   // ACKs; a slow peripheral ACK must not release already-late motion.
   for(const {line,first} of requests)if(first<=line.plan.session.clock.sync.getClock(serialClock.now())+BigInt(Math.ceil(.025*line.plan.clock.frequency)))throw new Error('Motion lead exhausted while enabling motors');
   for(const {line,first} of requests){line.enabled=true;line.readyAt=first;}
  }catch(error){try{await this.#group.stop(error);}catch(stop){throw new AggregateError([error,stop],'Motor enable and group stop failed');}throw error;}
  finally{this.#busy=false;}
 }
}
