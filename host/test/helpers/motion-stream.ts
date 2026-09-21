import assert from 'node:assert/strict';
import {TrapQueue} from '../../src/motion/trap-queue.ts';
import {MotionCoordinator} from '../../src/motion/coordinator.ts';
import {inputShaper} from '../../src/motion/shaper.ts';
const settings={frequency:1e6,timeOffset:0,oid:3,maxError:0,queueStepTag:5,directionTag:6};
export async function trajectory(kind:number,stream:boolean,capture=true){
 using q=new TrapQueue();using step=q.createStepper(settings,kind?'extruder':'x',.01);if(kind)step.configurePressureAdvance(.05,.04);else step.configureShapers({x:inputShaper('mzv',40,.1)});
 const ticks:{clock:bigint;position:bigint}[]=[];let position=0n;
 const c=new MotionCoordinator([{id:'axis',queue:q,stepper:step}],{async commit(b){const out=b.outputs[0];position=out.position;if(capture)for(let i=0;i<out.history.length;i+=6){const [first,,start,count,interval,add]=out.history.slice(i,i+6),n=count<0n?-count:count;for(let j=0n;j<n;j++)ticks.push({clock:first+j*interval+add*j*(j+1n)/2n,position:start+(count<0n?-1n:1n)*(j+1n)});}},async stop(){}});
 let time=1;for(let i=0;i<2;i++){q.appendRaw(new Float64Array([time,.1,.8,.1,i?9:0,0,0,kind?1:i?-1:1,kind&&!i?1:0,0,0,kind&&i?-10:10,kind&&i?-100:100]));time=((time+.1)+.8)+.1;if(stream){assert.equal(await c.advanceSource(time),true);assert.ok(c.status.generatedTime+step.scanWindow.future<time);assert.ok(c.status.generatedTime-c.status.committedTime>=.001);}}
 await c.drain(time,new Map([[q,[0,0,0] as const]]));ticks.sort((a,b)=>a.clock<b.clock?-1:a.clock>b.clock?1:0);return {ticks,position};
}
