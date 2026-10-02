import assert from 'node:assert/strict';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {readStepperDistance} from '../src/config/stepper.ts';
import {TrapQueue} from '../src/motion/trap-queue.ts';
const section=new ConfigurationReader(new ConfigurationSource('/stepper.cfg',{stepper_x:{rotation_distance:'40',microsteps:'16',gear_ratio:'80:16'}},[]),null).section('stepper_x'),values=[{wall:[] as number[],cpu:[] as number[]},{wall:[] as number[],cpu:[] as number[]}];
const rows=new Float64Array([1,.1,.8,.1,0,0,0,1,0,0,0,10,100]);
function trace(configured:boolean){const distance=configured?readStepperDistance(section).stepDistance:1/400;using q=new TrapQueue();q.appendRaw(rows);using s=q.createStepper({frequency:1e6,timeOffset:0,oid:3,maxError:0,queueStepTag:5,directionTag:6},'x',distance);s.generate(2);return s.flush();}
assert.deepEqual(trace(true),trace(false));
for(let run=0;run<14;run++)for(const mode of run%2?[0,1]:[1,0]){
 const used=process.cpuUsage(),start=performance.now();for(let i=0;i<100;i++)assert.equal(trace(!!mode).position,3600n);const elapsed=(performance.now()-start)/100,cpu=process.cpuUsage(used);
 if(run>=3){values[mode].wall.push(elapsed);values[mode].cpu.push((cpu.user+cpu.system)/100000);}
}
const stats=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[5],p95Ms:v[10]};},[direct,configured]=values.map(v=>({wall:stats(v.wall),cpu:stats(v.cpu)}));
console.log(JSON.stringify({node:process.version,samples:11,trajectoriesPerSample:100,pulsesPerTrajectory:3600,direct,configured,maxTickError:0,scope:'Configuration read plus native step generation/compression. Independent 1/400 mm baseline, identical packets and history; no physical motion acceptance.'}));assert(configured.wall.medianMs<=direct.wall.medianMs*1.5+.05,'Configured step distance generation regression');assert(configured.cpu.medianMs<=direct.cpu.medianMs*1.5+.05,'Configured step distance CPU regression');
