import assert from 'node:assert/strict';
import {PrinterPins} from '../src/protocol/pins.ts';
const pins=Object.fromEntries(Array.from({length:32},(_,i)=>[[`P${i}`,i],[`A${i}`,i]]).flat()),samples=[{wall:[] as number[],cpu:[] as number[]},{wall:[] as number[],cpu:[] as number[]}];
for(let run=0;run<14;run++)for(const mapped of run%2?[0,1]:[1,0]){
 const start=performance.now(),used=process.cpuUsage();
 for(let i=0;i<100;i++){
  const registry=new PrinterPins<object>();registry.register('mcu',{});
  if(mapped)registry.lookupBatch([{description:'P0'}],new Map([['mcu',{pins}]]));else registry.lookup('P0');
  for(let pin=1;pin<32;pin++)registry.lookup(`P${pin}`);assert.equal(registry.claimedPins.length,32);
 }
 const wall=(performance.now()-start)/100,cpu=process.cpuUsage(used);if(run>=3){samples[mapped].wall.push(wall);samples[mapped].cpu.push((cpu.user+cpu.system)/100000);}
}
const stats=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[5],p95Ms:v[10]};},[names,physical]=samples.map(v=>({wall:stats(v.wall),cpu:stats(v.cpu)}));
console.log(JSON.stringify({node:process.version,samples:11,registriesPerSample:100,pinsPerRegistry:32,names,physical,scope:'Startup pin acquisition with a copied 64-name GPIO map; no motion or device IO.'}));assert(physical.wall.medianMs<10,'Physical ownership startup exceeded 10 ms for 32 pins');assert(physical.cpu.medianMs<10,'Physical ownership startup CPU exceeded 10 ms for 32 pins');
