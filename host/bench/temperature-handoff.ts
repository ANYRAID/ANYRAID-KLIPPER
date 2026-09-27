import assert from 'node:assert/strict';
import {TemperatureStore} from '../src/moonraker/temperature-store.ts';
const measurements=[];
for(const count of [32,128]){
 const names=Array.from({length:count},(_,i)=>'sensor '+i),status=Object.fromEntries(names.map((name,i)=>[name,{temperature:i+.125,target:200,power:.5,speed:1}]));
 const previous=new TemperatureStore();previous.configure(names,[],status);for(let i=1;i<1200;i++)previous.sample(status);
 const times=[];
 for(let run=0;run<22;run++){
  const start=performance.now(),next=new TemperatureStore({},previous);next.configure(names,[],status);const elapsed=performance.now()-start;
  assert.deepEqual(next.snapshot(),previous.snapshot());if(run>=2)times.push(elapsed);
 }
 times.sort((a,b)=>a-b);measurements.push({sensors:count,fields:4,capacity:1200,slots:count*4*1200,medianMs:times[10],p95Ms:times[18],maxMs:times[19]});
}
console.log(JSON.stringify({node:process.version,measurements,scope:'20 measured handoffs after 2 warmups; exact history verified outside timed interval. Runs only during quiescent reinitialization, not during printing. No Python equivalent lifecycle or hardware timing claim.'},null,2));
