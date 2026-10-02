import assert from 'node:assert/strict';
import {AsyncPrinterHeaters} from '../src/thermal/async-heaters.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
const count=1000,wall:number[][]=[[],[]],cpu:number[][]=[[],[]];
for(let round=0;round<14;round++)for(const mode of round%2?[1,0]:[0,1]){
 let checkpoints=0,barriers=0;const group=new AsyncPrinterHeaters(()=>{barriers++;}),dispatch=new GCodeDispatch({output(){},shutdown(){}});
 group.registerSensor('sensor',{getTemperature:()=>({temperature:100,target:0,stale:false})});await group.start();group.attach(dispatch,{},mode?async()=>{checkpoints++;}:undefined);dispatch.setReady(true);
 try{
  const used=process.cpuUsage(),start=performance.now();for(let i=0;i<count;i++)await dispatch.execute('TEMPERATURE_WAIT SENSOR=sensor MINIMUM=50');
  const elapsed=(performance.now()-start)*1000/count,usage=process.cpuUsage(used);if(round>=3){wall[mode].push(elapsed);cpu[mode].push((usage.user+usage.system)/count);}
  assert.equal(checkpoints,0);assert.equal(barriers,mode?count:0);assert.equal(group.status.closed,false);
 }finally{await group.shutdown();}
}
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianUs:a[5],p95Us:a[10]};},timing=wall.map(stats),usage=cpu.map(stats),limits={medianRatio:2,medianSlackUs:15,p95Us:100};
console.log(JSON.stringify({node:process.version,warmup:3,samples:11,commandsPerSample:count,variants:['withoutCheckpoints','withCheckpoints'],timing,cpu:usage,limits,scope:'Fresh already-satisfied temperature commands, real dispatch and heater registry, no native IO or physical heating.'}));
assert(timing[1].medianUs<timing[0].medianUs*limits.medianRatio+limits.medianSlackUs);assert(timing[1].p95Us<limits.p95Us);assert(usage[1].medianUs<usage[0].medianUs*limits.medianRatio+limits.medianSlackUs);
