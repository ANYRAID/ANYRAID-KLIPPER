import {MCUGroup} from '../runtime/mcu-group.ts';
import {DigitalOutput,compileDigital,type DigitalConfig} from './digital.ts';
import {PrintClockTimeline} from '../timing/print-clock-timeline.ts';
import {snapshotPrintClock} from '../timing/print-clock.ts';
import type {MotionOutput} from '../motion/coordinator.ts';
import {serialClock} from '../protocol/serial-queue.ts';
import {decodeInteger} from '../protocol/codec.ts';
import {waitForMcuClocks} from '../timing/mcu-clock-barrier.ts';
const compiledPlans=new WeakSet<object>();
function enableClock(calibration:Readonly<{offset:number;frequency:number}>,timeline?:PrintClockTimeline){
 const fixed=snapshotPrintClock(calibration);if(!timeline)return fixed;
 const current=timeline.status.calibration;if(current.offset!==fixed.offset||current.frequency!==fixed.frequency)throw new Error('Motor enable timeline calibration differs');
 return Object.freeze({get offset(){return timeline.status.calibration.offset;},get frequency(){return timeline.status.calibration.frequency;},clockAt:(time:number)=>timeline.clockAt(time),printTimeAtClock:(tick:bigint)=>timeline.printTimeAtClock(tick)});
}
function atOrBefore(clock:ReturnType<typeof enableClock>,time:number):bigint{const tick=clock.clockAt(time);return clock.printTimeAtClock(tick)>time?tick-1n:tick;}
function atOrAfter(clock:ReturnType<typeof enableClock>,time:number):bigint{const tick=clock.clockAt(time);return clock.printTimeAtClock(tick)<time?tick+1n:tick;}
export interface MotorEnableLine<T=unknown> {
 mcu:string;emitters:readonly string[];chip:T;pin:DigitalConfig<T>['pin'];oid:number;
 /** Board/driver setup margin before the first physical step, in seconds. */
 leadTime:number;timeline?:PrintClockTimeline;calibration:Readonly<{offset:number;frequency:number}>;
}
/** Compile before configuring MCUs. Driver enables default off and do not use
 * a repeating watchdog; whole-group device shutdown supplies emergency off. */
export function compileMotorEnable<T>(group:MCUGroup,line:MotorEnableLine<T>){
 if(line.pin.chipName!==line.mcu||!Number.isFinite(line.leadTime)||line.leadTime<=0||line.leadTime>.1||!line.emitters.length||new Set(line.emitters).size!==line.emitters.length||line.emitters.some(id=>!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)))throw new Error('Invalid motor enable ownership or lead time');
 const clock=enableClock(line.calibration,line.timeline),session=group.session(line.mcu);
 const config=compileDigital(line.chip,session.dictionary,{oid:line.oid,pin:line.pin,start:false,shutdown:false,maxDuration:0});
 // Resolve firmware aliases to the actual numeric GPIO identity, rather than
 // treating two names for the same pin as independently ownable outputs.
 const encoded=session.dictionary.encodeCommand(config.config),tag=decodeInteger(encoded),oid=decodeInteger(encoded,tag.next),physicalPin=decodeInteger(encoded,oid.next).value;
 const plan=Object.freeze({mcu:line.mcu,physicalPin,emitters:Object.freeze([...line.emitters]),leadTime:line.leadTime,timeline:line.timeline,clock,session,config});compiledPlans.add(plan);return plan;
}
type Plan=ReturnType<typeof compileMotorEnable>;
const alwaysPlans=new WeakSet<object>();
/** Configuration fact only: no GPIO exists, so software cannot promise that
 * the driver is powered off, including after emergency MCU shutdown. */
export function compileAlwaysOnMotors(group:MCUGroup,options:{mcu:string;emitters:readonly string[];timeline?:PrintClockTimeline;calibration:Readonly<{offset:number;frequency:number}>}){
 if(!options.emitters.length||options.emitters.length>128||new Set(options.emitters).size!==options.emitters.length||options.emitters.some(id=>!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)))throw new Error('Invalid always-on motor ownership');
 const plan=Object.freeze({mcu:options.mcu,emitters:Object.freeze([...options.emitters]),timeline:options.timeline,clock:enableClock(options.calibration,options.timeline),session:group.session(options.mcu)});alwaysPlans.add(plan);return plan;
}
type AlwaysOn=ReturnType<typeof compileAlwaysOnMotors>;
const owners=new WeakSet<object>();
const physicalOwners=new WeakMap<Plan['session'],{pins:Set<number>;oids:Set<number>}>();
/** Dedicated enable lines remain asserted across normal drain and homing
 * recovery. ACK confirms scheduling, not electrical driver readiness. */
export class MotorEnable {
 #group:MCUGroup;#lines:{plan:Plan;output:DigitalOutput;enabled:boolean;readyAt?:bigint}[];#byEmitter=new Map<string,number>();
 #always=new Map<string,AlwaysOn>();
 #abort=new AbortController();#off:()=>void;#busy=false;
 constructor(group:MCUGroup,plans:readonly Plan[],alwaysOn:readonly AlwaysOn[]=[]){
  group.assertActive();if(!plans.length&&!alwaysOn.length||plans.length+alwaysOn.length>128||new Set([...plans,...alwaysOn]).size!==plans.length+alwaysOn.length)throw new Error('Invalid motor enable plans');
  const pins=new Set<string>(),oids=new Set<string>();
  for(const [i,p] of plans.entries()){
   const pin=`${p.mcu}:${p.physicalPin}`,oid=`${p.mcu}:${p.config.oid}`,claimed=physicalOwners.get(p.session);
   if(!compiledPlans.has(p)||owners.has(p)||claimed?.pins.has(p.physicalPin)||claimed?.oids.has(p.config.oid)||group.session(p.mcu)!==p.session||!p.session.status.configured||pins.has(pin)||oids.has(oid))throw new Error('Motor enables require dedicated configured MCU outputs');pins.add(pin);oids.add(oid);
   for(const id of p.emitters){if(this.#byEmitter.has(id))throw new Error('Motor belongs to multiple enable lines');this.#byEmitter.set(id,i);}
  }
  for(const p of alwaysOn){
   if(!alwaysPlans.has(p)||owners.has(p)||group.session(p.mcu)!==p.session||!p.session.status.configured)throw new Error('Always-on motors require configured MCU ownership');
   for(const id of p.emitters){if(this.#byEmitter.has(id)||this.#always.has(id))throw new Error('Motor belongs to multiple enable lines');this.#always.set(id,p);}
  }
  this.#group=group;this.#lines=plans.map(plan=>({plan,output:new DigitalOutput(plan.config,plan.session.dictionary,group.commandQueue(plan.mcu),time=>plan.timeline?plan.timeline.reserve(time):plan.clock.clockAt(time)),enabled:false}));
  for(const p of plans){owners.add(p);const claimed=physicalOwners.get(p.session)??{pins:new Set<number>(),oids:new Set<number>()};claimed.pins.add(p.physicalPin);claimed.oids.add(p.config.oid);physicalOwners.set(p.session,claimed);}
  for(const p of alwaysOn)owners.add(p);
  this.#off=group.subscribeStop(cause=>{this.#abort.abort(cause);this.#off();});
 }
 get canReleaseAll(){return this.#always.size===0;}
 get status(){return {stopped:this.#abort.signal.aborted,busy:this.#busy,canReleaseAll:this.canReleaseAll,alwaysOn:[...this.#always].map(([emitter,p])=>({emitter,mcu:p.mcu})),lines:this.#lines.map(l=>({mcu:l.plan.mcu,emitters:[...l.plan.emitters],enabled:l.enabled}))};}
 assertBindings(group:MCUGroup,bindings:readonly {id:string;mcu:string;calibration:{offset:number;frequency:number}}[],printTime:number):void{
  if(group!==this.#group||bindings.length!==this.#byEmitter.size+this.#always.size||new Set(bindings.map(b=>b.id)).size!==bindings.length)throw new Error('Motor enable binding coverage differs');
  for(const b of bindings){const i=this.#byEmitter.get(b.id),line=i===undefined?undefined:this.#lines[i],p=line?.plan??this.#always.get(b.id);if(!p||p.mcu!==b.mcu||p.clock.offset!==b.calibration.offset||p.clock.frequency!==b.calibration.frequency)throw new Error('Motor enable physical MCU or clock differs');if(line?.readyAt!==undefined&&p.clock.clockAt(printTime)<line.readyAt)throw new Error('Rebuilt motion precedes scheduled motor readiness');}
  this.#group.assertActive();this.#abort.signal.throwIfAborted();
 }
 /** Normal all-motor release. Caller must fence admission and complete motion
  * drain first. Preserve the original 100 ms guard on each side of disable. */
 async disableAll(printTime:number,signal:AbortSignal):Promise<void>{
  if(!this.canReleaseAll)throw new Error('Always-on motors cannot be released by software');
  this.#group.assertActive();if(this.#busy)throw new Error('Motor enable operation already active');this.#busy=true;
  const local=AbortSignal.any([signal,this.#abort.signal]);
  try{
   local.throwIfAborted();if(!Number.isFinite(printTime)||printTime<0)throw new RangeError('Invalid motor release boundary');
   const active=this.#lines.filter(l=>l.enabled);if(!active.length)return;
   const requests=active.map(line=>{const p=line.plan,now=p.session.clock.sync.getClock(serialClock.now()),boundary=p.clock.clockAt(printTime),last=line.output.status.lastClock,base=now>boundary?now:boundary,latest=base>last?base:last,guard=BigInt(Math.ceil(.1*p.clock.frequency)),tick=p.timeline?atOrAfter(p.clock,p.clock.printTimeAtClock(latest)+.1):latest+guard,time=p.clock.printTimeAtClock(tick);if(p.clock.clockAt(time)!==tick)throw new Error('Motor release clock is not exactly representable');const after=p.timeline?atOrAfter(p.clock,time+.1):tick+guard;p.timeline?.reserveClock(after);return {line,time,after};});
   await Promise.all(requests.map(({line,time})=>line.output.setDigital(time,false,local)));
   local.throwIfAborted();this.#group.assertActive();
   await waitForMcuClocks(requests.map(({line,after})=>({clock:line.plan.session.clock,tick:after})),local);
   local.throwIfAborted();this.#group.assertActive();for(const {line} of requests){line.enabled=false;line.readyAt=undefined;}
  }catch(error){try{await this.#group.stop(error);}catch(stop){throw new AggregateError([error,stop],'Motor release and group stop failed');}throw error;}
  finally{this.#busy=false;}
 }
 /** Called inside the sink's history/commit ownership, before any step packet
  * is accepted by transport. Idle initialization records never enable motors. */
 async beforeSteps(outputs:readonly MotionOutput[]):Promise<void>{
  this.#group.assertActive();this.#abort.signal.throwIfAborted();if(this.#busy)throw new Error('Motor enable commit already active');this.#busy=true;
  try{
   const earliest=new Map<number,bigint>();
   for(const out of outputs){const plan=this.#always.get(out.id)??this.#lines[this.#byEmitter.get(out.id)!]?.plan;if(plan?.timeline)for(let i=0;i<out.history.length;i+=6)plan.timeline.reserveClock(out.history[i+1]);if(this.#always.has(out.id))continue;const index=this.#byEmitter.get(out.id);if(index===undefined)throw new Error('Unknown motor enable emitter');if(this.#lines[index].enabled)continue;
    for(let i=0;i<out.history.length;i+=6){const first=out.history[i],count=out.history[i+3];if(count===0n)continue;const prior=earliest.get(index);if(prior===undefined||first<prior)earliest.set(index,first);}
   }
   // Validate every line before submitting any enable. One shared pin receives
   // one transition at the earliest member pulse, without reference-count races.
   const requests=[...earliest].map(([index,first])=>{const line=this.#lines[index],p=line.plan,tick=p.timeline?atOrBefore(p.clock,p.clock.printTimeAtClock(first)-p.leadTime):first-BigInt(Math.ceil(p.leadTime*p.clock.frequency));if(tick<=p.session.clock.sync.getClock(serialClock.now()))throw new Error('Motor enable lead time exhausted');const time=p.clock.printTimeAtClock(tick);if(p.clock.clockAt(time)!==tick)throw new Error('Motor enable clock is not exactly representable');return {line,time,first};});
   await Promise.all(requests.map(({line,time})=>line.output.setDigital(time,true,this.#abort.signal)));
   this.#group.assertActive();this.#abort.signal.throwIfAborted();
   // Keep the native streamer's 25 ms minimum packet lead after all enable
   // ACKs; a slow peripheral ACK must not release already-late motion.
   for(const {line,first} of requests){const p=line.plan,now=p.session.clock.sync.getClock(serialClock.now()),deadline=p.timeline?atOrAfter(p.clock,p.clock.printTimeAtClock(now)+.025):now+BigInt(Math.ceil(.025*p.clock.frequency));if(first<=deadline)throw new Error('Motion lead exhausted while enabling motors');}
   for(const {line,first} of requests){line.enabled=true;line.readyAt=first;}
  }catch(error){try{await this.#group.stop(error);}catch(stop){throw new AggregateError([error,stop],'Motor enable and group stop failed');}throw error;}
  finally{this.#busy=false;}
 }
}
