import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
import {GcodeStore} from '../src/moonraker/gcode-store.ts';
const iterations=100,runs=9,warmups=2,lines=1000,script=Array(lines).fill('REPORT').join('\n');
const samples:{baseline:number[];history:number[]}={baseline:[],history:[]};
for(let run=0;run<runs+warmups;run++)for(const mode of run%2?['history','baseline'] as const:['baseline','history'] as const){
 const dispatch=new GCodeDispatch({output(){},shutdown(){assert.fail('Unexpected shutdown');}}),store=new GcodeStore(1000);
 dispatch.register('REPORT',c=>c.respondRaw('// native response'));dispatch.setReady(true);
 const stop=mode==='history'?dispatch.observeOutput(message=>store.record(message,'response')):()=>{};
 const start=performance.now();for(let i=0;i<iterations;i++)await dispatch.execute(script);const elapsed=performance.now()-start;
 assert.equal(dispatch.outputObservation.failures,0);assert.equal(store.status.records,mode==='history'?1000:0);stop();
 if(run>=warmups)samples[mode].push(elapsed);
}
const stats=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[Math.floor(v.length/2)],p95Ms:v[Math.ceil(v.length*.95)-1]};};
const baseline=stats(samples.baseline),history=stats(samples.history);
console.log(JSON.stringify({node:process.version,warmups,runs,responsesPerRun:iterations*lines,baseline,history,addedMedianMicrosecondsPerResponse:(history.medianMs-baseline.medianMs)*1000/(iterations*lines),scope:'Alternating same-process dispatch without observer versus bounded history observer. No network fanout, Python, target board or physical motion comparison.'},null,2));
