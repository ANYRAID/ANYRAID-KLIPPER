import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {inputShaper} from '../src/motion/shaper.ts';
const settings={frequency:1e6,timeOffset:0,oid:3,maxError:0,queueStepTag:5,directionTag:6};
const rows=new Float64Array([1,.1,.8,.1,0,0,0,1,0,0,0,10,100,2,0,.1,0,9,0,0,0,0,0,0,0,0]);
const modes=['linear','identity','mirror','linear-shaped','mirror-shaped'] as const;
const samples:Record<string,number[]>={};for(const mode of modes)samples[mode]=[];
for(let round=0;round<9;round++)for(const mode of [...modes.slice(round%modes.length),...modes.slice(0,round%modes.length)]){
 const start=performance.now();
 for(let i=0;i<300;i++){
  using q=new TrapQueue();q.appendRaw(rows);using s=q.createStepper(settings,'x',.01);
  if(mode==='identity'||mode.startsWith('mirror'))s.configureCarriage({xScale:mode==='identity'?1:-1,xOffset:mode==='identity'?0:180,yScale:1,yOffset:0});
  if(mode.endsWith('shaped'))s.configureShapers({x:inputShaper('mzv',40,.1)});
  s.generate(2.05);assert.equal(s.flush().position,mode.startsWith('mirror')?-900n:900n);
 }
 if(round>=2)samples[mode].push(performance.now()-start);
}
const results=Object.fromEntries(modes.map(mode=>{const times=samples[mode],median=[...times].sort((a,b)=>a-b)[3];return [mode,{milliseconds:times,medianMs:median,stepsPerSecond:270000/median*1000}];}));
console.log(JSON.stringify({runtime:process.version,scope:'300 fresh queue/solver lifecycles, 270000 steps per sample; simulated host only, no MCU transport',results},null,2));
