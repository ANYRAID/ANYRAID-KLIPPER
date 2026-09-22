import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {motanSOSFilter} from '../src/motan/sos-filter.ts';
import {sosOracle} from '../test/helpers/motan-sos-oracle.ts';
import type {SOSCase} from '../test/helpers/motan-sos-oracle.ts';

const stats = (times:number[]) => {
  times.sort((a,b) => a-b); return {median:times[3],p95:times[6]};
};
for (const count of [20000, 200000]) {
  const source = Array.from({length:count},(_,i) => Math.sin(i*.017)+.2*Math.cos(i*.731));
  const cases:SOSCase[] = ['filt','filtfilt'].map(mode => ({
    kind:'bandpass',order:8,cutoff:[10,200],source,mode:mode as SOSCase['mode'],
  }));
  const references=sosOracle(cases,true);
  for (const input of [source, Float64Array.from(source)]) {
  for (let c=0;c<cases.length;c++) {
    const reference=references[c],ms:number[]=[];
    let maxError=0;
    for (let i=0;i<9;i++) {
      const start=performance.now();
      const result=motanSOSFilter(reference.sos,input,cases[c].mode);
      const elapsed=performance.now()-start;
      for(let j=0;j<count;j++) maxError=Math.max(maxError,Math.abs(result[j]-reference.values[j]));
      assert.ok(maxError<2e-10);
      if(i>=2) ms.push(elapsed);
    }
    console.log(JSON.stringify({node:process.version,input:input.constructor.name,samples:count,sections:reference.sos.length,
      mode:cases[c].mode,nodeMs:stats(ms),scipyMs:stats(reference.ms),maxAbsoluteError:maxError}));
  }
  }
}
