import test from 'node:test';
import assert from 'node:assert/strict';
import {ClockSync} from '../src/timing/clock-sync.ts';
import {SecondarySync} from '../src/timing/secondary-sync.ts';
import {PrintClockTimeline} from '../src/timing/print-clock-timeline.ts';
import {CalibrationCadence} from '../src/timing/calibration-cadence.ts';
import {homingPositionOffsets} from '../src/homing/position-offsets.ts';
import {StepHistory} from '../src/motion/step-history.ts';
/** Independent 1 MHz clocks, known uptime and bounded wire processing delays.
 * The first two primary warmup replies are delayed 20 ms; later replies 1 ms.
 * MCU ticks represent receive/processing time, not the host send timestamp. */
function simulate(cadence:{run(now:number,attempt:()=>boolean):boolean|undefined}){
 const main=new ClockSync(1e6,1000000n,10),local=new ClockSync(1e6,1000000n,10);
 const sample=(clock:ClockSync,t:number,delay:number,warmup:boolean)=>clock.accept({clock32:Math.round((t-9+delay)*1e6),sentTime:t,receiveTime:t+delay+.001},warmup);
 for(let i=1;i<=8;i++){const t=10+i*.05;sample(main,t,i<=2?.02:.001,true);sample(local,t,.001,true);}
 const start=10.405,sync=new SecondarySync(main,local,start),timeline=new PrintClockTimeline(sync.mapping);
 let lastSample=10.4,maximum=0,updates=0,hit=0n,mapped=0n;
 for(let i=0;i<=600;i++){
  const now=start+i*.025,truth=1+now-10;
  if(now-lastSample>=.9839){sample(main,now,.001,false);sample(local,now,.001,false);lastSample=now;}
  cadence.run(now,()=>{const time=truth+.2,p=sync.propose(time,now),plan=sync.planPeripheral(p,timeline,time,time+.01);if(!plan)return false;sync.applyPeripheral(p,timeline,plan.tick);updates++;return true;});
  const tick=BigInt(Math.round(truth*1e6)),time=timeline.printTimeAtClock(tick);
  maximum=Math.max(maximum,Math.abs(time-truth)*1e6);
  if(i===120){hit=tick;mapped=BigInt(Math.floor(time*1e6+.5));}
 }
 return {maximum,updates,hit,mapped};
}
test('one-second publication bounds a settled-estimator transient without weakening stopped-clock admission',t=>{
 // Freeze the replaced four-second policy as an independent counterexample.
 let next=0;
 const old=simulate({run(now,attempt){if(now<next)return;const ok=attempt();next=now+(ok?4:.25);return ok;}});
 const current=simulate(new CalibrationCadence());
 assert(old.maximum>8000);assert(current.maximum<3500);assert.equal(old.updates,4);assert.equal(current.updates,16);
 const histories=[new StepHistory(0n,0n),new StepHistory(0n,0n)];
 for(const history of histories)history.append({history:new BigInt64Array(),position:0n},20000000n);
 const stopped={hitClock:current.hit,reasons:[2,1],positions:[0,1].map(member=>({member,oid:0,raw:0,position:0n,observedClock:current.hit+4000n}))};
 const bindings=histories.map((history,member)=>({member,oid:0,history}));
 assert.throws(()=>homingPositionOffsets(stopped,bindings,[old.mapped,old.hit]),/Invalid mapped trigger clock/);
 assert.deepEqual(homingPositionOffsets(stopped,bindings,[current.mapped,current.hit]).map(p=>p.overshoot),[0n,0n]);
 t.diagnostic(JSON.stringify({old,current,scope:'Deterministic delayed warmup; original stopped tick rejection retained. Not the missing remote samples or target accuracy budget.'},(_,v)=>typeof v==='bigint'?String(v):v));
});
