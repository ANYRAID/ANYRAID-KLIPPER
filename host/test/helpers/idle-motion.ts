import {TrapQueue} from '../../src/motion/trap-queue.ts';
import {MotionCoordinator} from '../../src/motion/coordinator.ts';
import type {CoordinatedMotionDrain} from '../../src/motion/coordinated-drain.ts';
import {PlannedMotionSource} from '../../src/motion/planned-motion-source.ts';
import {LookAheadQueue,Move,motionLimits} from '../../src/motion/lookahead.ts';
import {inputShaper} from '../../src/motion/shaper.ts';
/** Native motion with a memory sink only; no MCU timing or physical execution. */
export function idleMotionFixture(filtered=false){
 const xyz=new TrapQueue(),equeue=new TrapQueue();xyz.setPosition(0,50,0,0);equeue.setPosition(0,2,0,0);
 const settings={frequency:1e6,timeOffset:0,maxError:0,queueStepTag:5,directionTag:6};
 const x=xyz.createStepper({...settings,oid:3},'x',.01,[50,0,0]),e=equeue.createStepper({...settings,oid:4},'extruder',.01,[2,0,0]);
 if(filtered){x.configureShapers({x:inputShaper('mzv',40,.1)});e.configurePressureAdvance(.05,.04);}
 x.initializePosition(0n,100n);e.initializePosition(0n,20n);
 let commits=0,stops=0;const ticks:Record<string,[bigint,bigint][]>={x:[],e:[]},positions:Record<string,bigint>={};
 const coordinator=new MotionCoordinator([{id:'x',queue:xyz,stepper:x},{id:'e',queue:equeue,stepper:e}],{async commit(batch){commits++;for(const out of batch.outputs){positions[out.id]=out.position;for(let i=0;i<out.history.length;i+=6){const [first,,position,count,interval,add]=out.history.slice(i,i+6),n=count<0n?-count:count;for(let j=0n;j<n;j++)ticks[out.id].push([first+j*interval+add*j*(j+1n)/2n,position+(count<0n?-1n:1n)*(j+1n)]);}}},async stop(){stops++;}});
 const driver={get generatedTime(){return coordinator.status.generatedTime;},get finalizedSourceTime(){return coordinator.finalizedSourceTime;},usesQueues:(q:readonly TrapQueue[])=>coordinator.usesQueues(q),advanceIdleSource:(time:number)=>coordinator.advanceIdleSource(time),advanceSource:(time:number)=>coordinator.advanceSource(time,0,.25),drain:(time:number,p:ReadonlyMap<TrapQueue,readonly [number,number,number]>)=>coordinator.drain(time,p,.25),stop:(error:unknown)=>coordinator.shutdown(error)} as unknown as CoordinatedMotionDrain;
 const source=new PlannedMotionSource([{queue:xyz},{queue:equeue,extrusionAxis:3}],driver,0,[50,0,0,2]);
 Object.assign(driver,{replaceFuture:(time:number,moves:readonly Move[],routes:readonly {queue:TrapQueue;extrusionAxis?:number}[],position:readonly number[])=>coordinator.replaceFuture(time,moves,routes,position)});
 return {source,coordinator,x,e,xyz,equeue,ticks,positions,get commits(){return commits;},get stops(){return stops;},close(){x.dispose();e.dispose();xyz.dispose();equeue.dispose();}};
}
export function idleTestMove(start=50,end=51,extrusion=2.1){const q=new LookAheadQueue();q.add(new Move(motionLimits(100,1000),[start,0,0,2],[end,0,0,extrusion],10));return q.flush();}
